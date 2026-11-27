import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { storeWhatsappModeOf, storeWhatsappPhone } from './store-whatsapp';
import { displayNumberOf } from './whatsapp/inbound';

/**
 * «زر واتساب بالمتجر» (the owner, 26/11): the store's setting decides which number the shop's WhatsApp button opens — never the code.
 */
describe('the store WhatsApp button', () => {
  const store = { supportPhone: '0790000000', whatsappNumber: null as string | null, whatsappMode: 'EXTERNAL' };

  it('a store that never touched the setting opens the support phone, as every shop did before it', () => {
    expect(storeWhatsappPhone({ supportPhone: '0790000000' }, '+962600000000')).toBe('0790000000');
    expect(storeWhatsappModeOf(undefined)).toBe('EXTERNAL');
    expect(storeWhatsappModeOf('SOMETHING')).toBe('EXTERNAL');
  });

  it('EXTERNAL opens the number written for the button, the support phone when it is blank', () => {
    expect(storeWhatsappPhone({ ...store, whatsappNumber: '+962 79 000 1234' }, null)).toBe('+962 79 000 1234');
    expect(storeWhatsappPhone({ ...store, whatsappNumber: '   ' }, null)).toBe('0790000000');
  });

  it('API opens the connected Business number, so the message lands in the OMS inbox', () => {
    expect(storeWhatsappPhone({ ...store, whatsappMode: 'API', whatsappNumber: '+962790001234' }, '+962600000000')).toBe('+962600000000');
  });

  it('API with no number connected falls back to the outside number rather than drawing no button', () => {
    expect(storeWhatsappPhone({ ...store, whatsappMode: 'API', whatsappNumber: '+962790001234' }, null)).toBe('+962790001234');
    expect(storeWhatsappPhone({ ...store, whatsappMode: 'API' }, '')).toBe('0790000000');
  });

  it('no number anywhere is no button', () => {
    expect(storeWhatsappPhone({ whatsappMode: 'API' }, null)).toBeNull();
  });
});

describe('the Business number is learned from the webhook, never typed', () => {
  it('reads metadata.display_phone_number as +digits', () => {
    expect(displayNumberOf({ metadata: { display_phone_number: '963 952 349 466' } })).toBe('+963952349466');
  });

  it('anything that is not a number is nothing', () => {
    expect(displayNumberOf({ metadata: { display_phone_number: 'abc' } })).toBeNull();
    expect(displayNumberOf({ metadata: {} })).toBeNull();
    expect(displayNumberOf(null)).toBeNull();
  });
});
