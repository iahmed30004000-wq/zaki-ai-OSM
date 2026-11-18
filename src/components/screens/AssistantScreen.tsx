'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { useApp } from '@/context/AppContext';
import { findRoute, routeLabel } from '@/lib/route-registry';
import { RiCheckboxCircleLine, RiLightbulbLine, RiRobot2Line, RiSendPlaneLine, RiShieldFlashLine, RiSparkling2Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { PageShell } from '@/components/ui/PageShell';
import { arTime } from '@/lib/format';
import { userCan } from '@/lib/can';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  time: string;
}

export function AssistantScreen() {
  const { t, currentUser } = useApp();
  const [summaryData, setSummaryData] = useState<any>(null);
  /*
   * The summary is the company's money across every store, so it is the
   * finance key's with every country — the same two the server asks. Anyone
   * else gets the server's one line saying why, and no button that fails.
   */
  const maySeeSummary =
    userCan(currentUser, 'finance.view') &&
    (currentUser?.role === 'SUPER_ADMIN' || userCan(currentUser, 'geo.manage'));
  const [summaryReason, setSummaryReason] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        'أهلاً. أمامي أرقام متجرك الحقيقية: الطلبات، ودفعات الإنتاج، ونسب تحويل المودريتورية، وصافي الربح من المسلَّم. اسألني عمّا تريد معرفته.',
      time: arTime(new Date()),
    },
  ]);
  const [inputQuery, setInputQuery] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  const suggestedQuestions = [
    'كيف كان أداء المتجر اليوم؟',
    'أي منتج هو الأكثر ربحاً؟',
    'أي مودريتور أداؤه الأفضل؟',
    'أي منتج نسبة رفضه الأعلى؟',
    'هل أزيد إنتاج هذا المنتج؟',
  ];

  const loadSummary = async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch('/api/ai/daily-summary');
      if (res.ok) {
        const data = await res.json();
        setSummaryData(data.summary);
        setSummaryReason(typeof data.reasonAr === 'string' ? data.reasonAr : null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSummary(false);
    }
  };

  const handleGenerateSummary = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/ai/daily-summary', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSummaryData(data.summary);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    loadSummary();
  }, []);

  const handleSendMessage = async (textToSend?: string) => {
    const q = textToSend || inputQuery;
    if (!q.trim()) return;

    const userMsg: ChatMessage = {
      role: 'user',
      content: q,
      time: arTime(new Date()),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, period: 'all' }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.answer,
            time: arTime(new Date()),
          },
        ]);
      } else {
        throw new Error('تعذّر الحصول على إجابة');
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'تعذّر الوصول إلى الأرقام. حاول مرّة أخرى، وإن تكرّر فالمشكلة في إعداد الذكاء لا في سؤالك.',
          time: arTime(new Date()),
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  let observations: string[] = [];
  let risks: string[] = [];
  let recommendations: string[] = [];
  let metrics: any = null;

  if (summaryData) {
    try {
      observations = summaryData.observations ? JSON.parse(summaryData.observations) : [];
      risks = summaryData.risks ? JSON.parse(summaryData.risks) : [];
      recommendations = summaryData.recommendations
        ? JSON.parse(summaryData.recommendations)
        : [];
      metrics = summaryData.metricsJson ? JSON.parse(summaryData.metricsJson) : null;
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <>
      <PageShell title={routeLabel('/assistant')}
            description="يجيب من أرقام متجرك وحدها. ما لا يجده في البيانات يقول إنه لا يعرفه، ولا يخترع رقماً."
            actions={
              maySeeSummary ? (
              <><Button
            size="sm"
            onClick={() => { void handleGenerateSummary(); }}
            loading={generating}
            className="flex items-center space-x-1.5"
          >
            <RiSparkling2Line className="w-4 h-4" />
            <span>أعد توليد الملخّص</span>
          </Button></>
              ) : undefined
            }
          >

        {summaryReason && (
          <p className="text-note text-[var(--sys-muted-foreground)]">{summaryReason}</p>
        )}

        {/* The daily summary — the one thing this screen has that the dock does not. */}
        {summaryData && (
          <div className="space-y-4">
            {/* Executive Summary Card */}
            <Card className="border-[var(--sys-primary-soft)] bg-gradient-to-br from-[var(--sys-primary)]/10 to-[var(--sys-muted-foreground)]/5">
              <CardHeader
                title={
                  <div className="flex items-center justify-between">
                    <span className="flex items-center space-x-2">
                      <RiSparkling2Line className="w-5 h-5 text-[var(--sys-primary)]" />
                      <span>ملخّص اليوم ({summaryData.date})</span>
                    </span>
                    <span className="text-note font-mono font-medium text-[var(--sys-muted)]">
                      المزوّد متصل
                    </span>
                  </div>
                }
                subtitle="ملخّصٌ محسوبٌ من الطلبات الحقيقيّة وكلفة البضاعة — لا تقديرات."
              />
              <CardContent className="space-y-4">
                <Card plain padding="md" className="text-sm font-medium text-[var(--sys-heading)] leading-relaxed">
                  <p>{summaryData.summaryText}</p>
                </Card>

                {/* Ground-truth Metrics Pill Bar */}
                {metrics && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-center text-note">
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">الطلبات</span>
                      <strong className="text-[var(--sys-heading)] font-bold">{metrics.total_orders}</strong>
                    </Card>
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">المؤكَّدة</span>
                      <strong className="text-[var(--sys-primary)] font-bold">{metrics.confirmed_orders}</strong>
                    </Card>
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">المُسلَّمة</span>
                      <strong className="text-[var(--sys-success)] font-bold">{metrics.delivered_orders}</strong>
                    </Card>
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">إيراد المُسلَّم</span>
                      <Money value={metrics.revenue} className="text-[var(--sys-heading)] font-bold" />
                    </Card>
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">صافي الربح</span>
                      <Money
                        value={metrics.net_profit}
                        tone={Number(metrics.net_profit) < 0 ? 'lost' : 'collected'}
                        className="font-black"
                      />
                    </Card>
                    <Card plain padding="sm">
                      <span className="text-note text-[var(--sys-muted)] block">نسبة التأكيد</span>
                      <strong className="text-[var(--sys-primary)] font-bold">{metrics.confirmation_rate}%</strong>
                    </Card>
                  </div>
                )}

                {/* 3 Pillars: Observations, Risks, Recommendations */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  {/* Key Observations */}
                  <Card plain padding="md">
                    <h4 className="text-note font-bold text-[var(--sys-muted-foreground)] flex items-center space-x-1.5 mb-2.5">
                      <RiLightbulbLine className="w-4 h-4 text-[var(--sys-muted-foreground)]" />
                      <span>ملاحظات</span>
                    </h4>
                    <ul className="space-y-2 text-note text-[var(--sys-foreground)]">
                      {observations.map((obs, i) => (
                        <li key={i} className="flex items-start space-x-1.5">
                          <span className="text-[var(--sys-destructive)] font-bold">•</span>
                          <span>{obs}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  {/* Risks */}
                  <div className="bg-[var(--sys-destructive-soft)]/70 border border-[var(--sys-destructive-border)] rounded-lg p-4">
                    <h4 className="text-note font-bold text-[var(--sys-destructive)] flex items-center space-x-1.5 mb-2.5">
                      <RiShieldFlashLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                      <span>مخاطر تحتاج تدخّلاً</span>
                    </h4>
                    <ul className="space-y-2 text-note text-[var(--sys-foreground)]">
                      {risks.map((risk, i) => (
                        <li key={i} className="flex items-start space-x-1.5">
                          <span className="text-[var(--sys-destructive)] font-bold">•</span>
                          <span>{risk}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Recommendations */}
                  <div className="bg-[var(--sys-success-soft)]/70 border border-[var(--sys-success)]/30 rounded-lg p-4">
                    <h4 className="text-note font-bold text-[var(--sys-success)] flex items-center space-x-1.5 mb-2.5">
                      <RiCheckboxCircleLine className="w-4 h-4 text-[var(--sys-success)]" />
                      <span>توصيات</span>
                    </h4>
                    <ul className="space-y-2 text-note text-[var(--sys-foreground)]">
                      {recommendations.map((rec, i) => (
                        <li key={i} className="flex items-start space-x-1.5">
                          <span className="text-[var(--sys-destructive)] font-bold">•</span>
                          <span>{rec}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* THE SAME CHAT AS THE BUBBLE ON EVERY SCREEN.
            Both post to /api/ai/chat. This is a fuller view of it — room
            for a long conversation — and it is where the menu entry leads.
            Said here so nobody rebuilds it a third time. */}
        <Card className="flex flex-col h-[550px]">
          <CardHeader
            title={<span className="flex items-center space-x-2"><RiRobot2Line className="w-5 h-5 text-[var(--sys-primary)]" /><span>اسأل عن أرقامك</span></span>}
            subtitle="اسأل عن أداء متجرك — الإجابة محسوبةٌ من أرقام قاعدة بياناتك، ومحدودةٌ بما تسمح به صلاحيتك."
          />

          {/* Chat Messages */}
          <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`flex items-start space-x-3 rtl:space-x-reverse ${
                  m.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {m.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-full bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] flex items-center justify-center shrink-0 shadow-raised">
                    <RiRobot2Line className="w-4 h-4" />
                  </div>
                )}

                <div
                  className={`max-w-xl rounded-lg px-4 py-3 text-sm leading-relaxed shadow-raised ${
                    m.role === 'user'
                      ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] rounded-tr-none'
                      : 'bg-[var(--sys-surface)] text-[var(--sys-heading)] rounded-tl-none whitespace-pre-wrap'
                  }`}
                >
                  <p>{m.content}</p>
                  <span
                    className={`text-note block mt-1 text-right ${
                      m.role === 'user' ? 'text-[var(--sys-primary-foreground)]/80' : 'text-[var(--sys-muted)]'
                    }`}
                  >
                    {m.time}
                  </span>
                </div>

                {m.role === 'user' && (
                  <div className="w-8 h-8 rounded-full bg-[var(--sys-surface-strong)] text-[var(--sys-primary)] flex items-center justify-center shrink-0 font-bold text-note">
                    U
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="flex items-center space-x-2 text-note text-[var(--sys-muted)]">
                <RiRobot2Line className="w-4 h-4 text-[var(--sys-primary)] animate-spin" />
                <span>يقرأ أرقام متجرك…</span>
              </div>
            )}
          </CardContent>

          {/* Quick Prompts Bar */}
          <div className="px-4 py-2 bg-[var(--sys-surface)] border-t border-[var(--sys-border)] flex items-center space-x-2 rtl:space-x-reverse overflow-x-auto text-note">
            <span className="text-[var(--sys-muted)] shrink-0 font-medium">جرّب أن تسأل:</span>
            {suggestedQuestions.map((sq, i) => (
              <Button
                key={i}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => { void handleSendMessage(sq); }}
                className="shrink-0"
              >
                {sq}
              </Button>
            ))}
          </div>

          {/* Input Bar */}
          <div className="p-3 border-t border-[var(--sys-border)] bg-[var(--sys-card)]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-center space-x-2 rtl:space-x-reverse"
            >
              <input
                type="text"
                placeholder="اسأل عن الإيراد، أو أكثر المنتجات ربحاً، أو أداء المودريتورات، أو التشغيل…"
                value={inputQuery}
                onChange={(e) => setInputQuery(e.target.value)}
                className="flex-1 px-4 py-2 text-sm bg-[var(--sys-surface)] border border-[var(--sys-border-input)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-primary)]/30 focus:border-[var(--sys-primary)]"
              />
              <IconButton type="submit" variant="primary" size="sm" loading={chatLoading} label="ابعت السؤال">
                <RiSendPlaneLine className="icon-mirror w-4 h-4" />
              </IconButton>
            </form>
          </div>
        </Card>
      </PageShell>
    </>
  );
}
