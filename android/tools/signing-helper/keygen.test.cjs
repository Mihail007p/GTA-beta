'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Exercise the exact vendored browser build with browser-style randomness.
const browser = {crypto: webcrypto, setTimeout, clearTimeout, Uint8Array, ArrayBuffer};
browser.window = browser;
browser.self = browser;
vm.createContext(browser);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'forge.min.js'), 'utf8'), browser);
const forge = browser.forge;
const {generate, restore} = require('./keygen.js');

function unpack(material) {
  const asn1 = forge.asn1.fromDer(Buffer.from(material.keystore).toString('binary'));
  return forge.pkcs12.pkcs12FromAsn1(asn1, material.password);
}

test('generated keystore has an encrypted RSA-3072 signing entry with the expected alias', async () => {
  const material = await generate(webcrypto, forge);
  assert.equal(material.password.length, 64);
  assert.match(material.password, /^[0-9a-f]+$/);
  assert.match(material.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const p12 = unpack(material);
  const bags = p12.getBags({friendlyName: 'openstreet-release'}).friendlyName;
  const cert = bags.find(bag => bag.cert)?.cert;
  const privateKey = bags.find(bag => bag.key)?.key;
  assert.ok(cert);
  assert.ok(privateKey);
  assert.equal(privateKey.n.bitLength(), 3072);
  assert.equal(privateKey.n.toString(16), cert.publicKey.n.toString(16));
  assert.equal(privateKey.e.toString(16), cert.publicKey.e.toString(16));
  assert.ok(cert.verify(cert));
  assert.ok(cert.validity.notBefore < new Date());
  assert.ok(cert.validity.notAfter.getUTCFullYear() >= new Date().getUTCFullYear() + 29);
  assert.throws(() => forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer(Buffer.from(material.keystore).toString('binary')), 'incorrect password'));
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const actualFingerprint = forge.md.sha256.create().update(certDer).digest().toHex().toUpperCase().match(/../g).join(':');
  assert.equal(material.fingerprint, actualFingerprint);
});

test('independent generations do not reuse keys or passwords', async () => {
  const first = await generate(webcrypto, forge);
  const second = await generate(webcrypto, forge);
  assert.notEqual(first.password, second.password);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notDeepEqual(first.keystore, second.keystore);
});

test('saved backup restores to the same certificate and rejects incorrect files', async () => {
  const original = await generate(webcrypto, forge);
  const restored = await restore(webcrypto, forge, original.keystore, original.password);
  assert.equal(restored.fingerprint, original.fingerprint);
  assert.equal(restored.password, original.password);
  await assert.rejects(restore(webcrypto, forge, original.keystore, 'wrong'), /Не удалось/);
  await assert.rejects(restore(webcrypto, forge, new Uint8Array([1, 2, 3]), original.password), /Не удалось/);
  await assert.rejects(restore(webcrypto, forge, new Uint8Array(30001), original.password), /Выберите/);
});

test('missing secure cryptography fails closed', async () => {
  await assert.rejects(generate(null, forge), /HTTPS/);
  await assert.rejects(generate(webcrypto, null), /HTTPS/);
  await assert.rejects(restore(null, forge, new Uint8Array([1]), 'a'), /HTTPS/);
});
