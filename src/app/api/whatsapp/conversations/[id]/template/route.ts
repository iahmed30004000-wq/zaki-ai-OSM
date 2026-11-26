/**
 * POST /api/whatsapp/conversations/[id]/template — the way out of a closed 24-hour window: the company's approved template
 * (the one named on «بعد لا يرد», the call sheet's own), sent to this conversation. No body: the template, its words and the
 * credentials are the server's.
 */
import { NextResponse } from 'next/server';
import { sendWindowTemplate } from '@/lib/whatsapp/send';
import { viewOf } from '@/lib/whatsapp/message-view';
import { apiErrorResponse } from '@/lib/api-error';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await sendWindowTemplate(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
    }
    return NextResponse.json({ message: viewOf(result.message) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
