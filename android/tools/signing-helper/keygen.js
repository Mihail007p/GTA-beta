/* Local-only Android release keystore generation. No network or persistence. */
(function (root) {
  'use strict';

  function toBinary(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return result;
  }

  function fromBinary(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hex(bytes, separator = '') {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(separator);
  }

  async function certificateFingerprint(cryptoProvider, forge, cert) {
    const certDer = fromBinary(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
    return hex(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', certDer)), ':');
  }

  async function restore(cryptoProvider, forge, keystore, password) {
    if (!cryptoProvider || !cryptoProvider.subtle || !forge) {
      throw new Error('Для проверки ключа нужен современный браузер и HTTPS.');
    }
    if (!(keystore instanceof Uint8Array) || keystore.length === 0 || keystore.length > 30000 || !password) {
      throw new Error('Выберите сохранённый файл .p12 и подходящий файл с паролем.');
    }
    try {
      const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(keystore)), password);
      const bags = p12.getBags({friendlyName: 'openstreet-release'}).friendlyName || [];
      const cert = bags.find(bag => bag.cert)?.cert;
      const key = bags.find(bag => bag.key)?.key;
      if (!cert || !key || !key.n || !cert.publicKey.n || key.n.bitLength() < 2048 ||
          key.n.toString(16) !== cert.publicKey.n.toString(16) ||
          key.e.toString(16) !== cert.publicKey.e.toString(16)) throw new Error('invalid entry');
      return {keystore, password, fingerprint: await certificateFingerprint(cryptoProvider, forge, cert)};
    } catch (_) {
      throw new Error('Не удалось открыть ключ: проверьте файл .p12 и файл с паролем.');
    }
  }

  async function generate(cryptoProvider, forge) {
    if (!cryptoProvider || !cryptoProvider.subtle || !cryptoProvider.getRandomValues || !forge) {
      throw new Error('Для создания ключа нужен современный браузер и безопасное подключение HTTPS.');
    }

    // Generate RSA with the browser's native CSPRNG, not a JavaScript PRNG.
    const pair = await cryptoProvider.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'
    }, true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await cryptoProvider.subtle.exportKey('pkcs8', pair.privateKey));
    const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBinary(pkcs8)));
    pkcs8.fill(0);

    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    const serial = cryptoProvider.getRandomValues(new Uint8Array(16));
    serial[0] = (serial[0] & 0x7f) | 0x01; // positive, nonzero ASN.1 INTEGER
    cert.serialNumber = hex(serial);
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setUTCFullYear(cert.validity.notAfter.getUTCFullYear() + 30);
    const identity = [{name: 'commonName', value: 'Open Street Android Release'},
      {name: 'organizationName', value: 'Open Street'}];
    cert.setSubject(identity);
    cert.setIssuer(identity);
    cert.setExtensions([{name: 'basicConstraints', cA: false},
      {name: 'keyUsage', digitalSignature: true}]);
    cert.sign(privateKey, forge.md.sha256.create());

    // A unique 256-bit password; the keystore is encrypted even in backups.
    const passwordBytes = cryptoProvider.getRandomValues(new Uint8Array(32));
    const password = hex(passwordBytes).toLowerCase();
    passwordBytes.fill(0);
    const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
      algorithm: 'aes256', saltSize: 16, count: 10000,
      friendlyName: 'openstreet-release', generateLocalKeyId: true
    });
    const keystore = fromBinary(forge.asn1.toDer(p12).getBytes());
    const fingerprint = await certificateFingerprint(cryptoProvider, forge, cert);
    return {keystore, password, fingerprint};
  }

  const api = {generate, restore};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpenStreetKeygen = api;
})(globalThis);
