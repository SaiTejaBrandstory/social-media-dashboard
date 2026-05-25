import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg)]">
      <div className="panel p-8 w-full max-w-md text-center fadein">
        <div
          className="w-12 h-12 rounded-xl mx-auto mb-5 flex items-center justify-center mono text-[18px] font-bold text-white"
          style={{
            background: "linear-gradient(135deg,#5b54e5,#0d9488)",
          }}
        >
          404
        </div>
        <h1 className="text-[22px] font-bold mb-2">Page not found</h1>
        <p className="text-[13px] text-[var(--ink3)] mb-8 leading-relaxed">
          The page you’re looking for doesn’t exist or may have been moved.
          Check the URL or go back to the app home page.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <Link href="/" className="btn primary justify-center py-2.5">
            Go to home
          </Link>
          <Link href="/login" className="btn justify-center py-2.5">
            Sign in
          </Link>
        </div>
        <p className="text-[11px] text-[var(--ink3)] mt-6">
          BrandStory Strategy OS
        </p>
      </div>
    </div>
  );
}
