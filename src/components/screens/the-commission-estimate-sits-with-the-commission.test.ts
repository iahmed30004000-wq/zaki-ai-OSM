import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE COMMISSION ESTIMATE SITS WITH THE COMMISSION (the owner, 17/11).
 *
 * «حاسبة عمولة الموظفات (تقدير)» used to be drawn on «إعدادات النظام», two screens away from the real commission rules, and read like a second copy of them. It now
 * lives on `/settings/commission`, under the rules and the entries, and says in its own header that it is an estimate for the score and that the real commission is above.
 * One card, one place: this reads the three files so a later change cannot draw it twice or put it back.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const system = read('src/components/screens/SystemSettingsScreen.tsx');
const commission = read('src/components/screens/CommissionSettingsScreen.tsx');
const card = read('src/components/settings/AgentCommissionCard.tsx');

describe('the commission estimate card', () => {
  it('is drawn by the commission screen', () => {
    expect(commission).toContain("import { AgentCommissionCard } from '@/components/settings/AgentCommissionCard'");
    expect(commission).toContain('<AgentCommissionCard />');
  });

  it('is drawn by the commission screen once, after the rules and the entries and before the dialogs', () => {
    expect(commission.split('<AgentCommissionCard />')).toHaveLength(2);
    const at = commission.indexOf('<AgentCommissionCard />');
    expect(at).toBeGreaterThan(commission.indexOf('لا عمولات محتسبة هذا الشهر'));
    expect(at).toBeLessThan(commission.indexOf('<PayoutDialog'));
  });

  it('is no longer drawn by «إعدادات النظام»', () => {
    expect(system).not.toContain('AgentCommissionCard');
  });

  it('says in its own header that it is an estimate for the score and that the real commission is above', () => {
    expect(card).toContain('هاد تقدير للسكور، العمولة الحقيقية فوق');
    expect(card).toContain('ما بيغيّر قواعد العمولة ولا المحسوب ولا المصروف');
    expect(card).not.toContain('هدول بشاشة العمولة');
  });
});
