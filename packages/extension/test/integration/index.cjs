// The entry VS Code calls in the extension host: run every test here with mocha.
const path = require('node:path');
const Mocha = require('mocha');

exports.run = () => {
    const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: true });
    mocha.addFile(path.join(__dirname, 'extension.test.cjs'));
    return new Promise((resolve, reject) => {
        mocha.run(failures => failures > 0 ? reject(new Error(`${failures} integration tests failed`)) : resolve());
    });
};
