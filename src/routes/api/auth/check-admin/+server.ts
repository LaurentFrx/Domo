/**
 * Sonde `forward_auth` réservée à l'ADMINISTRATEUR — garde le Filebrowser
 * (/files, en mode sans mot de passe : cette route porte toute la garde).
 * Demande de Laurent (23/08) : « c'est uniquement le browser qui doit m'être
 * réservé » — un membre famille authentifié reçoit 403 (refus côté Caddy),
 * un anonyme est renvoyé vers /denied par les hooks.
 */
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) =>
  new Response(null, { status: locals.user?.role === 'admin' ? 204 : 403 });
