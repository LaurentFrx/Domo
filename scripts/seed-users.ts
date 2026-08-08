/**
 * Amorce `data/users.json` — à lancer UNE fois par installation (dev, puis prod,
 * car `data/` n'est pas partagé entre les deux dossiers).
 *
 *   node --experimental-strip-types scripts/seed-users.ts <email-admin> <email-famille>
 *
 * Idempotent : un email déjà présent est laissé tel quel (jamais écrasé, jamais
 * dupliqué), pour qu'un second passage ne réinitialise pas un compte en service.
 * Aucun PIN n'est posé : les champs pin* restent à null (phase séparée).
 */
import path from 'node:path';
import { createUser, findUserByEmail, readUsers } from '../src/lib/server/users-store.ts';

const [emailAdmin, emailFamille] = process.argv.slice(2);

if (!emailAdmin || !emailFamille) {
  console.error('usage: seed-users.ts <email-admin> <email-famille>');
  process.exit(1);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
for (const e of [emailAdmin, emailFamille]) {
  if (!EMAIL_RE.test(e)) {
    console.error(`email invalide : ${e}`);
    process.exit(1);
  }
}
if (emailAdmin.toLowerCase() === emailFamille.toLowerCase()) {
  console.error('les deux emails sont identiques');
  process.exit(1);
}

const cible = [
  { email: emailAdmin, role: 'admin' as const },
  { email: emailFamille, role: 'famille' as const }
];

for (const { email, role } of cible) {
  const existant = await findUserByEmail(email);
  if (existant) {
    console.log(`= déjà présent : ${email} (${existant.role}/${existant.status})`);
    continue;
  }
  const u = await createUser({ email, role, status: 'active' });
  console.log(`+ créé : ${u.email} — ${u.role}/${u.status} — id ${u.id}`);
}

console.log(`\n${path.resolve(process.cwd(), 'data', 'users.json')} :`);
console.table(
  (await readUsers()).map((u) => ({
    email: u.email,
    role: u.role,
    status: u.status,
    pin: u.pinHash ? 'défini' : '—',
    lastLoginAt: u.lastLoginAt ?? '—'
  }))
);
