import { describe, it, expect } from 'vitest';
import {
  readTransfer,
  transferKind,
  transferRefusal,
  TRANSFER_KIND_LABEL,
  type TransferSide,
} from './transfer-kind';

const wallet = (over: Partial<TransferSide> = {}): TransferSide => ({
  id: 'w1',
  name: 'الصندوق',
  currencyCode: 'USD',
  storeId: 'sA',
  countryId: 'SY',
  storeName: 'صحة بلس',
  countryName: 'سوريا',
  ...over,
});

describe('the four transfers, told apart by the wallets themselves', () => {
  it('two wallets of one store is an internal move', () => {
    const r = readTransfer(wallet(), wallet({ id: 'w2', name: 'البنك' }));
    expect(r.kind).toBe('INTERNAL');
    expect(r.label).toBe('تحويل داخلي');
    expect(r.detail).toBe('داخل صحة بلس — الصندوق ← البنك');
    expect(r.needsRate).toBe(false);
  });

  it('two stores in one country is a move between two sets of books', () => {
    const r = readTransfer(
      wallet(),
      wallet({ id: 'w2', storeId: 'sB', storeName: 'متجر ثانٍ' })
    );
    expect(r.kind).toBe('BETWEEN_STORES');
    expect(r.detail).toContain('دفتران مختلفان');
    expect(r.needsRate).toBe(false);
  });

  it('two countries is its own thing, and the only one that changes currency', () => {
    const r = readTransfer(
      wallet(),
      wallet({ id: 'w2', countryId: 'JO', currencyCode: 'JOD', storeId: 'sB', countryName: 'الأردن' })
    );
    expect(r.kind).toBe('BETWEEN_COUNTRIES');
    expect(r.detail).toBe('من سوريا (USD) إلى الأردن (JOD)');
    expect(r.needsRate).toBe(true);
  });

  it('a different country wins over a different store — it is the bigger fact', () => {
    expect(
      transferKind(wallet(), wallet({ id: 'w2', countryId: 'JO', storeId: 'sB' }))
    ).toBe('BETWEEN_COUNTRIES');
  });

  // A wallet nobody has placed yet is nobody's money, so pairing it with a
  // store's wallet still crosses a boundary. Calling that internal would
  // hide the move inside one store's daily closing.
  it('an unplaced wallet is not "the same store"', () => {
    expect(transferKind(wallet(), wallet({ id: 'w2', storeId: null }))).toBe('BETWEEN_STORES');
    expect(transferKind(wallet({ storeId: null }), wallet({ id: 'w2', storeId: null }))).toBe('INTERNAL');
  });

  it('asks for a rate only when the currency actually changes', () => {
    // Same country, same currency, different stores — no rate.
    expect(readTransfer(wallet(), wallet({ id: 'w2', storeId: 'sB' })).needsRate).toBe(false);
    // Different country but the same currency — still no rate to apply.
    expect(
      readTransfer(wallet(), wallet({ id: 'w2', countryId: 'LY', storeId: 'sB' })).needsRate
    ).toBe(false);
  });

  /*
   * THE FOURTH ACT — CHANGING ONE CURRENCY FOR ANOTHER INSIDE ONE COUNTRY.
   *
   * The owner, 10/11: «لازم يكون في تحويل اموال من نفس البلد الواحد: افرض
   * صرفت ليرة سوري لدولار والعكس». A shop in Syria holds a lira drawer and a
   * dollar drawer; turning one into the other is not a setup error.
   */
  it('one country, one store, two currencies is an exchange — and it needs a rate', () => {
    const r = readTransfer(
      wallet({ currencyCode: 'USD' }),
      wallet({ id: 'w2', name: 'صندوق الليرة', currencyCode: 'SYP' })
    );
    expect(r.kind).toBe('EXCHANGE');
    expect(r.label).toBe('صرف داخل البلد');
    expect(r.detail).toBe('صرف عملة داخل صحة بلس — من USD إلى SYP، بلد واحد ودفتر واحد');
    expect(r.needsRate).toBe(true);
  });

  it('and it works the other way round, lira to dollar, exactly the same', () => {
    const r = readTransfer(
      wallet({ currencyCode: 'SYP' }),
      wallet({ id: 'w2', currencyCode: 'USD' })
    );
    expect(r.kind).toBe('EXCHANGE');
    expect(r.needsRate).toBe(true);
  });

  it('two stores of one country with two currencies is still a move between two sets of books — that also needs a rate', () => {
    const r = readTransfer(
      wallet({ currencyCode: 'USD' }),
      wallet({ id: 'w2', currencyCode: 'SYP', storeId: 'sB', storeName: 'متجر ثانٍ' })
    );
    expect(r.kind).toBe('BETWEEN_STORES');
    expect(r.needsRate).toBe(true);
  });

  it('a different country still wins over everything, currency or not', () => {
    expect(
      transferKind(wallet({ currencyCode: 'USD' }), wallet({ id: 'w2', countryId: 'JO', currencyCode: 'SYP' }))
    ).toBe('BETWEEN_COUNTRIES');
  });

  it('an unplaced wallet beside a placed one is never an exchange: it is the bigger fact, two sets of books', () => {
    expect(
      transferKind(wallet({ currencyCode: 'USD' }), wallet({ id: 'w2', currencyCode: 'SYP', storeId: null }))
    ).toBe('BETWEEN_STORES');
  });

  it('every kind has a label, and the four are different words', () => {
    const labels = Object.values(TRANSFER_KIND_LABEL);
    expect(Object.keys(TRANSFER_KIND_LABEL).sort()).toEqual(['BETWEEN_COUNTRIES', 'BETWEEN_STORES', 'EXCHANGE', 'INTERNAL']);
    expect(new Set(labels).size).toBe(4);
    expect(TRANSFER_KIND_LABEL.EXCHANGE).toBe('صرف داخل البلد');
  });
});

describe('pairs that must be refused rather than recorded', () => {
  it('a wallet to itself', () => {
    expect(transferRefusal(wallet(), wallet())).toBe('لا يمكن التحويل إلى نفس المحفظة');
  });

  /*
   * CHANGED ON PURPOSE, AND SAID SO IN THE PULL REQUEST.
   *
   * This pinned the OPPOSITE: «one country has one currency, so two wallets
   * there holding different ones is a setup error». That was the very thing
   * the owner asked to be able to do — a lira drawer and a dollar drawer in
   * one Syrian shop, and «صرفت ليرة لدولار». The refusal is gone; the pair is
   * an exchange (see the four kinds above), and the rate that makes it one is
   * still demanded by the route.
   */
  it('two currencies inside one country are an exchange, no longer a refusal', () => {
    expect(transferRefusal(wallet(), wallet({ id: 'w2', currencyCode: 'JOD', storeId: 'sB' }))).toBeNull();
    expect(transferRefusal(wallet(), wallet({ id: 'w2', currencyCode: 'SYP' }))).toBeNull();
    expect(transferRefusal(wallet({ currencyCode: 'SYP' }), wallet({ id: 'w2', currencyCode: 'USD' }))).toBeNull();
  });

  it('and the only pair left to refuse is a wallet to itself, whatever else is true of it', () => {
    expect(transferRefusal(wallet({ currencyCode: 'SYP' }), wallet({ currencyCode: 'SYP' }))).toBe(
      'لا يمكن التحويل إلى نفس المحفظة'
    );
  });

  it('lets an ordinary pair through', () => {
    expect(transferRefusal(wallet(), wallet({ id: 'w2', name: 'البنك' }))).toBeNull();
    expect(
      transferRefusal(wallet(), wallet({ id: 'w2', countryId: 'JO', currencyCode: 'JOD', storeId: 'sB' }))
    ).toBeNull();
  });
});
