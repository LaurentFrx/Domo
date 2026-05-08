/**
 * HA Client — stub Phase 1.
 *
 * Phase 1.4 : implémentation réelle avec home-assistant-js-websocket
 * + OAuth2 PKCE flow.
 */

import { HA_CONFIG } from './config';

export class HAClient {
  private connected = false;

  async connect(): Promise<void> {
    console.log('[HAClient] Connect stub — Phase 1.4 implementation');
    console.log('[HAClient] HA URL:', HA_CONFIG.url);
    // TODO : OAuth2 PKCE + WebSocket
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const haClient = new HAClient();
