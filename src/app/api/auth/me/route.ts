import { NextResponse } from 'next/server';
import { getSessionVerdict } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';

export async function GET() {
  let verdict;
  try {
    verdict = await getSessionVerdict();
  } catch (error) {
    // A database that did not answer is a 503, never a 401 (the owner's ruling 4/11): «who am I» was not answered.
    return apiErrorResponse(error);
  }
  if (!verdict.user) {
    // A newer sign-in on a third device ended this one: the code travels so the screen can say so on /login.
    return NextResponse.json(
      verdict.reason === 'REPLACED' ? { user: null, code: 'SESSION_REPLACED' } : { user: null },
      { status: 401 }
    );
  }
  return NextResponse.json({ user: verdict.user });
}
