// Crockford-base32 ULID. 26 chars: 10 chars time (48 bits) + 16 chars random (80 bits).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(seedTime: number = Date.now()): string {
  let timeChars = '';
  let time = seedTime;
  for (let i = 0; i < 10; i++) {
    timeChars = ENCODING[time % 32] + timeChars;
    time = Math.floor(time / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randChars = '';
  for (let i = 0; i < 16; i++) {
    randChars += ENCODING[rand[i] % 32];
  }
  return timeChars + randChars;
}
