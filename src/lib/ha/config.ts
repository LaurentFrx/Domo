/**
 * Configuration de connexion à Home Assistant.
 */

export const HA_CONFIG = {
  url: 'https://maison.feroux.fr',
  wsPath: '/api/websocket',
  oauthAuthorizePath: '/auth/authorize',
  oauthTokenPath: '/auth/token',
  oauthCallbackUri: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '',
  oauthClientId: typeof window !== 'undefined' ? window.location.origin : ''
} as const;
