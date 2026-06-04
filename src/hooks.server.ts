import { redirect, type Handle } from '@sveltejs/kit';
import { isAuthenticated } from '$lib/server/auth';

const PUBLIC_PATHS = ['/auth', '/denied'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function isAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/_app/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/splash/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/registerSW.js' ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.ico')
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  // Endpoint portail : appelable par un raccourci iPhone sans cookie Domo.
  // Sa propre auth par token (Authorization: Bearer) est appliquée dans la route.
  // Match EXACT — ne PAS élargir aux autres routes /api.
  if (pathname === '/api/portail/pulse') {
    return resolve(event);
  }

  if (isAsset(pathname) || isPublic(pathname)) {
    return resolve(event);
  }

  if (!isAuthenticated(event.cookies)) {
    throw redirect(303, '/denied');
  }

  return resolve(event);
};
