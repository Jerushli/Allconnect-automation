
async function login(page, credentials) {
  if (!credentials?.password) {
    throw new Error('Password missing from .env');
  }

  // Step 1: Enter password
  const passwordField = page.getByRole('textbox', {
    name: 'Password'
  });

  await passwordField.waitFor({
    state: 'visible',
    timeout: 20000
  });

  await passwordField.fill(credentials.password);
  await passwordField.press('Enter');

  console.log('Password entered.');

  // Step 2: Start session
  const startSessionButton = page.getByRole('button', {
    name: 'START SESSION',
    exact: true
  });

  await startSessionButton.waitFor({
    state: 'visible',
    timeout: 20000
  });

  await startSessionButton.click();

  console.log('Session started.');

  // Step 3: Click Forward
  const forwardButton = page.getByRole('button', {
    name: 'Forward >',
    exact: true
  });

  await forwardButton.waitFor({
    state: 'visible',
    timeout: 20000
  });

  await forwardButton.click();

  console.log('Forward button clicked.');

  // Step 4: Verify Basic Information page
  const firstNameField = page.getByRole('textbox', {
    name: 'First Name'
  });

  await firstNameField.waitFor({
    state: 'visible',
    timeout: 20000
  });

  console.log('Basic Information page successfully opened.');

  return true;
}

module.exports = { login };
