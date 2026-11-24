import {NextResponse} from 'next/server';
import {isFirstRun} from '@/lib/onboarding/setup-token';
// GET - Just check if this is a first run (no token generation)
async function GET() {
  const firstRun = await isFirstRun();
  return NextResponse.json({ firstRun });
}

// CommonJS exports

export { GET };
