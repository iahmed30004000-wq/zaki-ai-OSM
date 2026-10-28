import React from 'react';

/**
 * STANDS IN FOR THE REAL ORDER FORM: A PREVIEW MUST NEVER TAKE AN ORDER.
 *
 * It lived inside the builder, which is a thousand-line client component.
 * The template gallery needs the same stand-in, and importing the builder
 * to get it would pull the whole editor into a picker — so it lives on its
 * own, and both render the one placeholder rather than two that drift.
 */
export function FormPlaceholder() {
  return (
    <div
      style={{
        border: '2px dashed var(--store-accent-border)',
        borderRadius: 'var(--store-radius)',
        padding: '28px 16px',
        textAlign: 'center',
        background: 'var(--store-accent-tint)',
      }}
    >
      <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--store-accent)' }}>نموذج الطلب</p>
      <p style={{ fontSize: 11.5, color: 'var(--store-muted)', marginTop: 4 }}>
        حقول «الدفع» تبع المتجر وبترتيبه — بتطلع كاملة بالصفحة المنشورة
      </p>
    </div>
  );
}
