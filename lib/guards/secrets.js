'use strict';

// What counts as a secret or as personal data in a piece of text: secrets of
// any kind, and personal data beyond a person's name and email address.
// scanText is used on the text web research would send out of the machine
// (guards/triage.js).
//
// Patterns aim at few false alarms: number formats are confirmed with their
// check digits where they have them (cards, IBANs, national ID and tax
// numbers), and generic secrets need a keyword such as "password" or
// "token" next to a value that looks random.

// --- secrets ------------------------------------------------------------------

const KNOWN_TOKENS = [
  ['a private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/],
  ['an API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['a SendGrid key', /\bSG\.[\w-]{22}\.[\w-]{43}\b/],
  ['an Azure SAS signature', /[?&]sig=[A-Za-z0-9%/+]{30,}/],
  // Classic Azure DevOps personal access token: 52 characters, a-z and 2-7.
  ['an Azure DevOps token', /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/],
];

// A long random string with no label: an access key, a storage key, a
// token. Paths (src/Components/...) and commit hashes don't count.
const UNLABELLED = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;
function looksLikeKey(value) {
  if (/^[0-9a-f]+$/i.test(value)) return false;
  if (value.includes('/') && value.split('/').some((part) => /^[A-Za-z]{4,}$/.test(part))) return false;
  if (!(/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value))) return false;
  return entropy(value) >= 4;
}

// Key=value pairs in connection strings and config: AccountKey=..., Password=...
const CONNECTION_SECRET = /\b(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd|ClientSecret|Client_Secret|ApiKey|Api_Key)\s*=\s*([^;'"\s,]{4,})/gi;
// password: value, "token": "value", api_key = value, Bearer value
const KEYWORD_SECRET = /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credentials?|auth(?:orization)?|pat)\b["']?\s*[:=]\s*["']?([^\s"',;}<>]{8,})/gi;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g;

// Values that are masked, placeholders or references, never secrets.
function isPlaceholder(value) {
  const text = String(value).trim();
  if (/^[*xX•.#_-]+$/.test(text) || /\*{3,}|•{3,}/.test(text)) return true;
  if (/^(<.*>|\$\{.*\}|\{\{.*\}\}|%[^%]+%|\$\(.*\)|\[.*\])$/.test(text)) return true;
  if (/^\$[A-Za-z_]/.test(text) || /^\$env:/i.test(text)) return true;
  if (/^(changeme|change_me|password|secret|token|example|redacted|placeholder|your[-_]?\w*|null|none|undefined|true|false|empty|string|todo|xxx+)$/i.test(text)) return true;
  // A code reference, not a value: config.Password, process.env.TOKEN, GetSecret(...)
  if (/[()]/.test(text) || /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(text)) return true;
  return false;
}

// How varied a string's characters are, in bits per character (Shannon
// entropy): about 4 or more for random keys, under 3 for words.
function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    total -= share * Math.log2(share);
  }
  return total;
}

// Random-looking: letters and digits mixed, or long and varied.
const looksRandom = (value) => (/[A-Za-z]/.test(value) && /\d/.test(value) && entropy(value) >= 2.8) || (value.length >= 24 && entropy(value) >= 3.5);

// --- personal data -------------------------------------------------------------

const digitsOf = (text) => text.replace(/\D/g, '');

function luhn(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = Number(number[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// Spanish DNI (8 digits + letter) and NIE (X/Y/Z + 7 digits + letter).
function dniValid(raw) {
  const value = raw.toUpperCase();
  const match = value.match(/^([XYZ]?)(\d{7,8})([A-Z])$/);
  if (!match) return false;
  const prefix = { '': '', X: '0', Y: '1', Z: '2' }[match[1]];
  const number = Number(prefix + match[2]);
  return 'TRWAGMYFPDXBNJZSQVHLCKE'[number % 23] === match[3];
}

// Fake card numbers that payment providers publish for testing (Stripe,
// Braintree/PayPal, Adyen, Worldpay and the classic test Visa). They can't
// charge anyone, so plans may mention them. Matched exactly: a real card is
// still blocked. Teams add their own in docs.test_card_numbers.
const TEST_CARDS = new Set([
  // Stripe
  '4242424242424242', '4000056655665556', '5555555555554444', '2223003122003222', '5200828282828210', '5105105105105100',
  '378282246310005', '371449635398431', '6011111111111117', '6011000990139424', '6011981111111113', '3056930009020004',
  '36227206271667', '6555900000604105', '3566002020360505', '6200000000000005', '4000002500003155', '4000000000003220',
  '4000000000009995', '4000000000000002', '4000000000000077', '4000000000000341', '4000000000000069', '4000000000000127',
  // Braintree / PayPal
  '4111111111111111', '4005519200000004', '4009348888881881', '4012000033330026', '4012000077777777', '4012888888881881',
  '4217651111111119', '4500600000000061', '2223000048400011', '3530111333300000', '6304000000000000',
  // Adyen
  '5555444433331111', '2222400070000005', '370000000000002', '4988438843884305',
  // Worldpay and others
  '4444333322221111', '5454545454545454', '4917610000000000003', '4222222222222',
]);

// Italian codice fiscale: 16 characters, the last one a check letter.
const CF_ODD = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19,
  J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
function codiceFiscaleValid(raw) {
  const cf = raw.toUpperCase();
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = cf[i];
    sum += i % 2 === 0 ? CF_ODD[ch] : (/\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65);
  }
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}

// French NIR (social security number): 13 digits and a 2-digit key, mod 97.
function nirValid(raw) {
  const value = raw.replace(/\s/g, '').toUpperCase().replace(/^(\d{5})2A/, '$119').replace(/^(\d{5})2B/, '$118');
  if (!/^[12]\d{14}$/.test(value)) return false;
  return 97 - (Number(value.slice(0, 13)) % 97) === Number(value.slice(13));
}

// Brazilian CPF: 11 digits, the last two are check digits.
function cpfValid(raw) {
  const digits = digitsOf(raw);
  if (digits.length !== 11 || /^(\d)\1+$/.test(digits)) return false;
  const checkDigit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
    return ((sum * 10) % 11) % 10;
  };
  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

// Belgian national number YY.MM.DD-XXX.CC: 97 minus the first nine digits mod 97
// (with a 2 in front for people born from 2000).
function belgianValid(raw) {
  const digits = digitsOf(raw);
  if (digits.length !== 11) return false;
  const check = Number(digits.slice(9));
  return 97 - (Number(digits.slice(0, 9)) % 97) === check || 97 - (Number(`2${digits.slice(0, 9)}`) % 97) === check;
}

// Words that introduce an ID number, in any country.
const ID_KEYWORDS = String.raw`tax\s*(?:id|number|no\.?)|taxpayer(?:\s*id)?|TIN|NIF|NIE|NIPC|VAT\s*(?:id|number|no\.?)|SSN|social\s+security(?:\s*(?:number|no\.?))?|passport(?:\s*(?:number|no\.?))?|(?:national\s+)?id(?:entity)?\s*card(?:\s*(?:number|no\.?))?|national\s+id(?:\s*number)?|BSN|burgerservicenummer|CPF|NIR|codice\s+fiscale|NINO|national\s+insurance(?:\s*(?:number|no\.?))?|DNI|cart[aã]o\s+de\s+cidad[aã]o|(?:n\.?[ºo]?\s*(?:de\s+)?)?contribuinte`;

const PERSONAL = [
  // Phone numbers only with a country code (+351 …, 00351 …): that format
  // works for every country and language. Numbers without one look like any
  // other number, so they aren't checked.
  {
    kind: 'a phone number',
    // Not in the middle of a longer digit group: 2223 0031 2200 3222 is one number.
    pattern: /(?<![\w+])(?<!\d[\s.-])(?:\+|00)[1-9][\d\s().-]{7,20}\d(?![\w])/g,
    confirm: (match) => digitsOf(match).length >= 9 && digitsOf(match).length <= 15,
  },
  { kind: 'an IBAN', pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, confirm: ibanValid },
  {
    kind: 'a card number',
    pattern: /(?<![\w.-])(?:\d[ .-]?){12,18}\d(?![\w-]|\.\d)/g,
    confirm: (match, groups, text, index, options) => {
      const digits = digitsOf(match);
      if (options.publishedTestCards && TEST_CARDS.has(digits)) return false;
      return digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && !/^(\d)\1+$/.test(digits) && luhn(digits);
    },
  },
  // Any country: an ID-looking value right after words like "tax ID", "SSN", "passport".
  {
    kind: 'an ID number',
    pattern: new RegExp(String.raw`\b(?:${ID_KEYWORDS})\b[^\w\n]{0,6}([A-Z0-9][A-Z0-9 ./-]{3,24}[A-Z0-9])`, 'gi'),
    confirm: (match, groups) => digitsOf(groups[1]).length >= 5,
  },
  // Without a keyword, only formats confirmed by their check digits or strict patterns.
  { kind: 'a tax ID', pattern: /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/g, confirm: codiceFiscaleValid },
  { kind: 'a social security number', pattern: /\b[12]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}\b/g, confirm: nirValid },
  { kind: 'a national insurance number', pattern: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g },
  { kind: 'a tax ID', pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, confirm: cpfValid },
  { kind: 'an ID number', pattern: /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b/g, confirm: belgianValid },
  { kind: 'an ID card number', pattern: /\b[XYZ]?\d{7,8}[A-Z]\b/g, confirm: dniValid },
  // Portuguese Cartão de Cidadão: 12345678 9 ZZ1
  { kind: 'an ID card number', pattern: /\b\d{8}\s?\d\s?[A-Z]{2}\d\b/g },
  { kind: 'a social security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    kind: 'a postal address',
    pattern: /\b\d{4}-\d{3}\b/g,
    confirm: (match, groups, text, index) => /\b(rua|avenida|av\.|travessa|largo|pra[cç]a|estrada|morada|c[oó]digo postal|street|road|avenue|address|postal code|zip)\b/i
      .test(text.slice(Math.max(0, index - 60), index + match.length + 60)),
  },
];

// --- scanning -----------------------------------------------------------------

const mask = (value) => {
  const text = String(value);
  return text.length <= 6 ? '***' : `${text.slice(0, 3)}…${text.slice(-2)}`;
};

// Every finding in one piece of text: [{ kind, sample }].
// publishedTestCards: false checks the providers' published test cards like
// real ones (for tests, which then never need an invented card number).
function scanText(text, { publishedTestCards = true } = {}) {
  const options = { publishedTestCards };
  const findings = [];
  // Same text whatever the characters look like: full-width digits become
  // digits, and invisible characters that split a token are removed.
  const value = String(text || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  for (const [kind, pattern] of KNOWN_TOKENS) {
    const match = value.match(pattern);
    if (match) findings.push({ kind, sample: mask(match[0]) });
  }
  for (const match of value.matchAll(CONNECTION_SECRET)) {
    if (!isPlaceholder(match[2])) findings.push({ kind: `a secret (${match[1]}=...)`, sample: mask(match[2]) });
  }
  for (const match of value.matchAll(KEYWORD_SECRET)) {
    if (!isPlaceholder(match[2]) && looksRandom(match[2])) findings.push({ kind: `a secret (${match[1]})`, sample: mask(match[2]) });
  }
  for (const match of value.matchAll(UNLABELLED)) {
    if (looksLikeKey(match[0]) && !findings.some((finding) => finding.sample === mask(match[0]))) findings.push({ kind: 'what looks like a key or token', sample: mask(match[0]) });
  }
  for (const match of value.matchAll(BEARER)) {
    if (!isPlaceholder(match[1])) findings.push({ kind: 'a bearer token', sample: mask(match[1]) });
  }
  for (const rule of PERSONAL) {
    for (const match of value.matchAll(rule.pattern)) {
      if (rule.confirm && !rule.confirm(match[0], match, value, match.index, options)) continue;
      findings.push({ kind: rule.kind, sample: mask(match[0]) });
    }
  }
  return findings;
}

module.exports = { scanText, TEST_CARDS };
