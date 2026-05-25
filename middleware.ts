import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Auth.js session cookie names (Edge-safe — no next-auth / Prisma imports). */
function hasSessionCookie(req: NextRequest): boolean {
  return (
    req.cookies.has("__Secure-authjs.session-token") ||
    req.cookies.has("authjs.session-token")
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/sc-app.js") ||
    /\.(ico|png|jpg|jpeg|svg|css|js|woff2?)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  const isLoggedIn = hasSessionCookie(req);

  if (pathname === "/login") {
    if (isLoggedIn) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
