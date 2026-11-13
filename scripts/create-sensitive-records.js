
const readline = require('readline');
const {
  saveSensitiveData,
  deleteSensitiveData
} = require('../src/sensitiveDataService');

function readMasked(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(new Error('Run this script in an interactive terminal.'));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let value = '';

    process.stdout.write(prompt);

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Input cancelled.'));
        return;
      }

      if (key.name === 'return' || character === '\r' || character === '\n') {
        cleanup();
        resolve(value);
        return;
      }

      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      if (
        character &&
        character.length === 1 &&
        !key.ctrl &&
        !key.meta
      ) {
        value += character;
        process.stdout.write('*');
      }
    }

    process.stdin.on('keypress', onKeypress);
  });
}

function validateSSN(value) {
  if (!/^\d{9}$/.test(value)) {
    throw new Error('SSN must contain exactly 9 digits.');
  }
}

function validateDOB(value) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (!match) {
    throw new Error('DOB must use MM/DD/YYYY format.');
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);

  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error('DOB is not a valid calendar date.');
  }
}

async function main() {
  let ssnRecord = null;
  let dobRecord = null;

  try {
    console.log('\nALLCONNECT ENCRYPTED RECORD CREATION');
    console.log('Use synthetic demo values only.\n');

    const ssn = await readMasked('Enter synthetic SSN (9 digits): ');
    validateSSN(ssn);

    const dob = await readMasked('Enter synthetic DOB (MM/DD/YYYY): ');
    validateDOB(dob);

    ssnRecord = await saveSensitiveData('ssn', ssn);
    dobRecord = await saveSensitiveData('dob', dob);

    console.log('\n[PASS] SSN encrypted and saved.');
    console.log('[PASS] DOB encrypted and saved.');

    console.log('\nRECORD IDS');
    console.log(JSON.stringify({
      ssnRecordId: ssnRecord.recordId,
      dateOfBirthRecordId: dobRecord.recordId
    }, null, 2));

    console.log('\nOnly record IDs were displayed.');
    console.log('Keep these IDs in your local test scenario.');
  } catch (error) {
    if (ssnRecord) {
      await deleteSensitiveData(ssnRecord.recordId).catch(() => {});
    }

    if (dobRecord) {
      await deleteSensitiveData(dobRecord.recordId).catch(() => {});
    }

    console.error('\n[FAILED]', error.message);
    process.exitCode = 1;
  }
}

main();
