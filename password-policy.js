const MIN_LENGTH = 12;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123', 'admin1234', 'abc123456',
  'iloveyou1', 'trustno1x', 'sunshine1', 'princess1', 'football1', 'baseball1',
  'dragon123', 'monkey123', 'shadow123', 'master1234', 'superman1', 'starwars1',
  'passw0rd1', 'p@ssw0rd1', 'changeme1', 'letmein12', 'welcome12', 'password!',
  '11111111', '00000000', '87654321', 'qazwsxedc', 'zxcvbnm12', 'asdfghjkl',
  '1q2w3e4r5t', 'aaaaaaaa1', 'default12', 'newpassword', 'temppass123',
  'password123!', 'password1234', 'welcome123!', 'iloveyou1234',
]);

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_LENGTH} characters` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(value)).length;
  if (classes < 3) {
    return { ok: false, reason: 'Password must include at least 3 of: lowercase, uppercase, numbers, symbols' };
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return { ok: false, reason: 'This password is too common — choose something harder to guess' };
  }
  return { ok: true };
}

module.exports = { validatePassword, MIN_LENGTH };
