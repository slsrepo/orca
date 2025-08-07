const assert = require('assert');
const generatePin = require('../generatePin');

const fakeLogger = { warn: () => {} };

// Provided PIN should be returned unchanged
const configWithPin = { bridge: { pin: '123-45-678' } };
assert.strictEqual(generatePin(configWithPin, fakeLogger), '123-45-678');

// Missing PIN should generate a random string matching the expected pattern
const configWithoutPin = { bridge: {} };
const pin = generatePin(configWithoutPin, fakeLogger);
assert.match(pin, /^\d{3}-\d{2}-\d{3}$/);

console.log('generatePin tests passed');
