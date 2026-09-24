const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-sales-test-'));
const port = 13991;
const baseUrl = `http://127.0.0.1:${port}`;
const adminKey = 'integration-admin-key';
let child;

async function api(method, pathname, body, token, extraHeaders = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? {'Content-Type': 'application/json'} : {}),
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return {status: response.status, json};
}

async function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY: adminKey,
      ADMIN_PASSWORD: adminKey,
      SESSION_SECRET: 'integration-session-secret',
      BALE_POLLING: 'false',
      ALLOW_DEMO: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited during startup with code ${child.exitCode}`);
    }
    try {
      const result = await api('GET', '/api/app/health');
      if (result.status === 200 && result.json.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Backend did not become healthy');
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

before(startServer);
after(async () => {
  await stopServer();
  fs.rmSync(dataDir, {recursive: true, force: true});
});

test('Android customer flow is backend-authoritative and persistent', async () => {
  const health = await api('GET', '/api/app/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const registration = await api('POST', '/api/app/register', {
    fullName: 'مشتری تست یکپارچه',
    businessName: 'فروشگاه تست یکپارچه',
    mobile: '09000000001',
    city: 'مشهد',
    password: 'before-change-123',
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.json.status, 'pending');

  const pendingLogin = await api('POST', '/api/app/login', {
    mobile: '09000000001',
    password: 'before-change-123',
  });
  assert.equal(pendingLogin.status, 403);

  const customers = await api('GET', '/api/admin/customers', null, null, {'X-Admin-Key': adminKey});
  const customer = customers.json.items.find(item => item.phone === '09000000001');
  assert.ok(customer);
  assert.equal(customer.status, 'pending');
  const customerNumber = customer.id;

  const activation = await api(
    'PUT',
    `/api/admin/customers/${encodeURIComponent(customer.id)}`,
    {status: 'active'},
    null,
    {'X-Admin-Key': adminKey},
  );
  assert.equal(activation.status, 200);
  assert.equal(activation.json.item.id, customerNumber);

  const login = await api('POST', '/api/app/login', {
    mobile: '09000000001',
    password: 'before-change-123',
  });
  assert.equal(login.status, 200);
  const token = login.json.accessToken;
  assert.ok(token);
  assert.equal(login.json.customer.customerNumber, customerNumber);
  assert.equal(login.json.customer.companyName, 'فروشگاه تست یکپارچه');
  assert.equal(login.json.customer.city, 'مشهد');

  const account = await api('GET', '/api/app/account', null, token);
  assert.equal(account.status, 200);
  assert.equal(account.json.customer.mobile, '09000000001');

  const catalog = await api('GET', '/api/app/catalog', null, token);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.json.items.length > 0);
  assert.ok(catalog.json.items.every(item => item.active === true));
  const product = catalog.json.items[0];
  assert.equal(product.active, true);

  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  const storedProduct = store.products.find(item => item.id === product.id);
  const customPrice = store.customerPrices.find(item => item.customerId === customerNumber && item.productId === product.id);
  const expectedPrice = customPrice?.price ?? storedProduct.groupPrices?.[customer.priceGroup] ?? storedProduct.basePrice;
  assert.equal(product.price, expectedPrice);

  const firstOrder = await api('POST', '/api/app/orders', {
    paymentMethod: 'credit',
    items: [{productId: product.id, qty: 2}],
  }, token);
  assert.equal(firstOrder.status, 201);
  assert.equal(firstOrder.json.order.id, `ALM-${customerNumber}-1`);
  assert.equal(firstOrder.json.order.items[0].unitPrice, expectedPrice);
  assert.match(firstOrder.json.order.createdAt, /\s/);

  const secondOrder = await api('POST', '/api/app/orders', {
    paymentMethod: 'credit',
    items: [{productId: product.id, qty: 1}],
  }, token);
  assert.equal(secondOrder.status, 201);
  assert.equal(secondOrder.json.order.id, `ALM-${customerNumber}-2`);

  const orderList = await api('GET', '/api/app/orders', null, token);
  assert.equal(orderList.status, 200);
  assert.deepEqual(
    new Set(orderList.json.items.map(item => item.id)),
    new Set([`ALM-${customerNumber}-1`, `ALM-${customerNumber}-2`]),
  );

  const detail = await api('GET', `/api/app/orders/${encodeURIComponent(firstOrder.json.order.id)}`, null, token);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.order.customerId, customerNumber);
  const anotherCustomersOrder = store.orders.find(item => item.customerId !== customerNumber);
  assert.ok(anotherCustomersOrder);
  const forbiddenDetail = await api('GET', `/api/app/orders/${encodeURIComponent(anotherCustomersOrder.id)}`, null, token);
  assert.equal(forbiddenDetail.status, 404);

  const phoneChange = await api('POST', '/api/app/phone-change-request', {
    newMobile: '09000000002',
    note: 'تست یکپارچه',
  }, token);
  assert.equal(phoneChange.status, 201);
  assert.equal(phoneChange.json.item.status, 'pending');
  const accountAfterRequest = await api('GET', '/api/app/account', null, token);
  assert.equal(accountAfterRequest.json.customer.mobile, '09000000001');

  const passwordChange = await api('POST', '/api/app/password-change', {
    currentPassword: 'before-change-123',
    newPassword: 'after-change-456',
  }, token);
  assert.equal(passwordChange.status, 200);
  assert.equal((await api('POST', '/api/app/login', {mobile: '09000000001', password: 'before-change-123'})).status, 401);
  assert.equal((await api('POST', '/api/app/login', {mobile: '09000000001', password: 'after-change-456'})).status, 200);

  await stopServer();
  await startServer();
  const persistedLogin = await api('POST', '/api/app/login', {
    mobile: '09000000001',
    password: 'after-change-456',
  });
  assert.equal(persistedLogin.status, 200);
  const persistedOrders = await api('GET', '/api/app/orders', null, persistedLogin.json.accessToken);
  assert.equal(persistedOrders.json.items.length, 2);
});
