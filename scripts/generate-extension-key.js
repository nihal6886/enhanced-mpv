const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generate 2048-bit RSA keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Save private key (add to .gitignore)
const privateKeyPath = path.join(__dirname, 'extension-key.pem');
fs.writeFileSync(privateKeyPath, privateKey);
console.log('Private key saved to:', privateKeyPath);

// Extract base64 DER public key for manifest.json
const publicKeyBase64 = publicKey.toString('base64');
console.log('Public key (base64 DER):', publicKeyBase64);

// Compute Chrome extension ID (first 16 bytes of SHA-256 of DER public key, mapped to a-p)
const sha256 = crypto.createHash('sha256').update(publicKey).digest();
const alphabet = 'abcdefghijklmnop';
let extensionId = '';
for (let i = 0; i < 16; i++) {
  extensionId += alphabet[sha256[i] >> 4];
  extensionId += alphabet[sha256[i] & 0x0f];
}
console.log('Extension ID:', extensionId);

// Output manifest.json key field value
console.log('\n--- Add to browser-extension/manifest.json ---');
console.log(`"key": "${publicKeyBase64}",`);