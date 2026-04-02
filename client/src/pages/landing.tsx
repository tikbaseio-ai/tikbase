import { Link } from 'wouter';

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

export default function LandingPage() {
  return (
    <div
      className="min-h-screen selection:bg-[#ddffaf] selection:text-[#3f6600]"
      style={{ backgroundColor: '#0e0e10', color: '#f9f5f8', fontFamily: "'Inter', sans-serif" }}
    >
      {/* TopNavBar */}
      <nav className="fixed top-0 w-full z-50 bg-neutral-950/80 backdrop-blur-xl">
        <div className="flex justify-between items-center px-8 h-20 max-w-7xl mx-auto w-full">
          <div className="text-white font-black text-xl tracking-tighter">TikBase</div>
          <div className="hidden md:flex items-center gap-8 font-['Space_Grotesk'] text-sm tracking-tight">
            <button onClick={() => scrollTo('features')} className="text-[#ddffaf] font-bold transition-colors duration-300 bg-transparent border-none cursor-pointer">Features</button>
            <button onClick={() => scrollTo('pricing')} className="text-neutral-400 hover:text-[#ddffaf] transition-colors duration-300 bg-transparent border-none cursor-pointer">Pricing</button>
            <button onClick={() => scrollTo('faq')} className="text-neutral-400 hover:text-[#ddffaf] transition-colors duration-300 bg-transparent border-none cursor-pointer">FAQ</button>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-neutral-400 font-['Space_Grotesk'] text-sm hover:text-[#ddffaf] transition-colors duration-300 no-underline">Log in</Link>
            <Link href="/signup" className="bg-[#ddffaf] text-[#3f6600] px-6 py-2.5 rounded-full font-['Space_Grotesk'] text-sm font-bold hover:brightness-110 active:scale-95 transition-all no-underline inline-block">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      <main className="pt-20">
        {/* Hero Section */}
        <section className="relative overflow-hidden px-8 pt-24 pb-12 md:pt-32 md:pb-24">
          <div className="max-w-7xl mx-auto flex flex-col items-center text-center">
            <h1 className="font-['Space_Grotesk'] text-5xl md:text-8xl font-bold tracking-tight mb-8 max-w-4xl" style={{ lineHeight: 1.05 }}>
              Know what's selling before everyone else.
            </h1>
            <p className="text-[#adaaad] text-lg md:text-xl max-w-2xl mb-12 leading-relaxed" style={{ fontFamily: "'Inter', sans-serif" }}>
              TikBase gives TikTok affiliate creators real-time product and video intelligence — so you promote winners, not guesses.
            </p>
            <div className="flex flex-col items-center gap-4">
              <Link href="/signup" className="bg-[#ddffaf] text-[#3f6600] px-10 py-5 rounded-full font-['Space_Grotesk'] text-lg font-bold hover:brightness-110 active:scale-95 transition-all no-underline inline-block" style={{ boxShadow: '0 0 40px rgba(221,255,175,0.15)' }}>
                Start Your 7-Day Free Trial
              </Link>
              <span className="font-['IBM_Plex_Mono'] text-xs text-[#767577] tracking-wider">$44.99/mo · Cancel anytime</span>
            </div>
            <div className="relative w-full max-w-6xl mx-auto mt-16" style={{ perspective: '1000px' }}>
              <div className="absolute -inset-10 bg-[#ddffaf]/20 blur-[120px] rounded-full -z-10" />
              <div className="relative rounded-lg overflow-hidden transform shadow-2xl border border-[#48474a]/20" style={{ boxShadow: '0 0 80px -20px rgba(163,255,0,0.3)' }}>
                <img
                  alt="SaaS Dashboard Interface"
                  className="w-full aspect-[16/10] object-cover"
                  src="/hero-dashboard.jpg"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0e0e10] via-transparent to-transparent opacity-40" />
              </div>
            </div>
          </div>
        </section>

        {/* Social Proof Bar */}
        <section className="py-16 border-y border-[#48474a]/10" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-7xl mx-auto px-8 flex flex-col md:flex-row items-center justify-center gap-8">
            <div className="flex -space-x-3">
              {[
                'https://lh3.googleusercontent.com/aida-public/AB6AXuDzLRFf4nXfPiLU1QldsEG91y_YUvs84WHdcgLCSXK0V89qgTM44fp7wU3mhPVpEsNFnjxHlzsSuVLzFWGv-H1psKNmP_4ujkeB1CSGC2dsIeWPK2TsH5s03OoZgJ3Kxrn5lnbt62_P2FTKlQFtJl1SP-rmV1HWtvfUSrs4mRggnLWC69cNhfdgF6pbiWUX0WmJfT6jVxwUmccqhd7HI7pG1Eh8bh7I14LopzmEUdeogtyIgVhFACDbnKM2JNPoTKTSGLpOaS1ARI0',
                'https://lh3.googleusercontent.com/aida-public/AB6AXuAEzy1XESNfFrB9eJm3LoxYG5QlxCgR8zhTPOL9KI1ykv8Kc2Hvd4McidVz6v7Guq5CuExyBRPAinneqzn4Dlh297zkgC70upppjlmFJMYkZZ8Swjp-kN11MYukwO_byab6A7_8Ajc47XGb00UYuqgMpaCWHdJlHHGd7ob24RmzoE5Z3B8RwlbtxpWaFVZEoE9ev-Dz-xUq3ilOCc7z4n-dTaC9f7GeYIoxHXfPSKbNGJxcuuA7JXCocB26Tcr-SaZCaWv8uGif6ME',
                'https://lh3.googleusercontent.com/aida-public/AB6AXuAGpKpmaOZ9Xvj3GUDCTq7aqrEtS-kTuyFIBlY8hVF02X44AUaremk-15koxFyJj0qFD2b5susuw0yV6DiUKqVXFet1VRNW9MH6XXsivwvVr3TNg4KyLW9gA8IHLp6U6nN2-Newllvl-FSrOHIYAV-FO03rUVSi1vQ9ZCA85WpPTOlSh_fXYF8Ohl222Po5YVsKvv99G55bfapNVMWvzsBkeSMrTwR7H_fXoIPlI5XmlVt6X6-6kICnjFCGivLW0TCUQ95zgTO_GOM',
                'https://lh3.googleusercontent.com/aida-public/AB6AXuAL33fz73qhOFxeyDETp_-kChwC-VgpWFSlZT05_kPpV4DShpewIgrvHMMo-5i5ABUa8HFYDycVlxfXOMPx5v54Irni3bvyrD1UfCUu-GmL_gbGlixEXY4VHBJvJVfVJ_Bvldx5HhG_x200c41bm6E26AMb-NHDip28yCeIDDqvb_aiFaw5yinIh_Kg1L-k024AtQIGlhvf8EIe63IAbwmlUoHaAaesxyzUmxPu4yVXSBqUFEUum4Dvb_1z_hJe1ro7lQt_gKKihcQ',
              ].map((src, i) => (
                <div key={i} className="w-10 h-10 rounded-full border-2 border-[#0e0e10] bg-[#262528] flex items-center justify-center overflow-hidden">
                  <img alt="User" className="w-full h-full object-cover" src={src} />
                </div>
              ))}
            </div>
            <p className="font-['Space_Grotesk'] text-lg font-medium tracking-tight">Trusted by 2,000+ TikTok creators</p>
          </div>
        </section>

        {/* Feature Highlights (Bento Grid) */}
        <section id="features" className="py-32 px-8">
          <div className="max-w-7xl mx-auto">
            <div className="mb-20">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold mb-6">Everything you need to find your next viral product</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="md:col-span-2 bg-[#19191c] rounded-lg p-10 hover:bg-[#2c2c2f] transition-colors group">
                <span className="material-symbols-outlined text-[#ddffaf] text-4xl mb-8 block">trending_up</span>
                <h3 className="font-['Space_Grotesk'] text-2xl font-bold mb-4 text-white">Top Products Leaderboard</h3>
                <p className="text-[#adaaad] leading-relaxed">Instantly access the highest converting TikTok Shop items across every category.</p>
              </div>
              <div className="md:col-span-2 bg-[#19191c] rounded-lg p-10 hover:bg-[#2c2c2f] transition-colors group">
                <span className="material-symbols-outlined text-[#ddffaf] text-4xl mb-8 block">play_circle</span>
                <h3 className="font-['Space_Grotesk'] text-2xl font-bold mb-4 text-white">Viral Video Rankings</h3>
                <p className="text-[#adaaad] leading-relaxed">Analyze the hooks and structures of videos that are actually generating sales.</p>
              </div>
              <div className="md:col-span-1 bg-[#19191c] rounded-lg p-8 hover:bg-[#2c2c2f] transition-colors">
                <span className="material-symbols-outlined text-[#ddffaf] text-3xl mb-6 block">bolt</span>
                <h3 className="font-['Space_Grotesk'] text-xl font-bold mb-3 text-white">Real-Time Data</h3>
                <p className="text-[#adaaad] text-sm leading-relaxed">Minute-by-minute updates on sales velocity.</p>
              </div>
              <div className="md:col-span-3 bg-[#19191c] rounded-lg p-8 hover:bg-[#2c2c2f] transition-colors flex items-center gap-8">
                <div className="flex-shrink-0">
                  <span className="material-symbols-outlined text-[#ddffaf] text-4xl">category</span>
                </div>
                <div>
                  <h3 className="font-['Space_Grotesk'] text-xl font-bold mb-2 text-white">28 Niches Covered</h3>
                  <p className="text-[#adaaad] text-sm leading-relaxed">From beauty to tech gadgets, we track everything so you don't have to.</p>
                </div>
                <div className="hidden md:flex ml-auto font-['IBM_Plex_Mono'] text-[#ddffaf] text-3xl font-bold">28+</div>
              </div>
            </div>
          </div>
        </section>

        {/* Dashboard Preview Side-by-Side */}
        <section className="py-32 px-8" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col md:flex-row items-end justify-between gap-8 mb-16">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold max-w-xl">Built for creators who take TikTok Shop seriously</h2>
              <span className="font-['IBM_Plex_Mono'] text-[#ddffaf] text-sm tracking-widest uppercase mb-2">Internal Alpha Access</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="rounded-lg overflow-hidden bg-[#19191c] shadow-xl">
                <img
                  alt="TikBase Videos Dashboard"
                  className="w-full h-full object-cover"
                  src="/screenshot-videos.jpg"
                />
              </div>
              <div className="rounded-lg overflow-hidden bg-[#19191c] shadow-xl">
                <img
                  alt="TikBase Products Dashboard"
                  className="w-full h-full object-cover"
                  src="/screenshot-products.jpg"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-32 px-8">
          <div className="max-w-7xl mx-auto text-center mb-20">
            <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold mb-4">Simple pricing. No hidden fees.</h2>
            <p className="text-[#adaaad]" style={{ fontFamily: "'Inter', sans-serif" }}>Choose the plan that fits your creator journey.</p>
          </div>
          <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Free Plan */}
            <div className="bg-[#19191c] rounded-lg p-12 flex flex-col border border-[#48474a]/10">
              <span className="font-['Space_Grotesk'] text-xl font-bold mb-2">Free</span>
              <div className="flex items-baseline gap-1 mb-8">
                <span className="font-['IBM_Plex_Mono'] text-4xl font-bold">$0</span>
                <span className="text-[#adaaad] text-sm">/mo</span>
              </div>
              <ul className="space-y-4 mb-12 text-left list-none p-0">
                <li className="flex items-center gap-3 text-sm text-[#adaaad]">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Top 5 Daily Products
                </li>
                <li className="flex items-center gap-3 text-sm text-[#adaaad]">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Limited Video Rankings
                </li>
                <li className="flex items-center gap-3 text-sm text-[#adaaad] opacity-50">
                  <span className="material-symbols-outlined text-lg">close</span>
                  Real-Time Sales Data
                </li>
              </ul>
              <Link href="/signup" className="mt-auto w-full py-4 rounded-full border border-[#48474a] text-white font-['Space_Grotesk'] font-bold hover:bg-[#262528] transition-colors text-center no-underline inline-block">
                Get Started
              </Link>
            </div>
            {/* Pro Plan */}
            <div className="bg-[#19191c] rounded-lg p-12 flex flex-col relative border-2 border-[#ddffaf]" style={{ boxShadow: '0 0 50px rgba(221,255,175,0.1)' }}>
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#ddffaf] text-[#3f6600] px-4 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold">
                Most Popular
              </div>
              <span className="font-['Space_Grotesk'] text-xl font-bold mb-2">Pro</span>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-8">
                <div className="flex items-baseline gap-1">
                  <span className="font-['IBM_Plex_Mono'] text-4xl font-bold text-white">$44.99</span>
                  <span className="text-[#adaaad] text-sm">/mo</span>
                </div>
                <div className="bg-[#a3ff00]/10 border border-[#a3ff00]/20 px-3 py-1.5 rounded-full">
                  <span className="text-[#a3ff00] font-bold text-[13px] font-['Space_Grotesk'] tracking-tight whitespace-nowrap">$31.49/mo (billed yearly) — Save 30%</span>
                </div>
              </div>
              <ul className="space-y-4 mb-12 text-left list-none p-0">
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Unlimited Product Access
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Full Video Hooks Library
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Real-Time Sales Tracker
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[#ddffaf] text-lg">check</span>
                  Priority Niche Support
                </li>
              </ul>
              <Link href="/signup" className="mt-auto w-full py-4 rounded-full bg-[#ddffaf] text-[#3f6600] font-['Space_Grotesk'] font-bold hover:brightness-110 active:scale-95 transition-all text-center no-underline inline-block">
                Start 7-Day Free Trial
              </Link>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="py-32 px-8" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-3xl mx-auto">
            <h2 className="font-['Space_Grotesk'] text-4xl font-bold mb-16 text-center">Frequently Asked Questions</h2>
            <div className="space-y-4">
              {[
                'How accurate is the sales data?',
                'Can I track specific competitors?',
                'How often is the product list updated?',
                'Is there a community for TikBase users?',
                'Can I cancel my subscription anytime?',
                'Do you provide video editing templates?',
              ].map((q, i) => (
                <div key={i} className="bg-[#19191c] rounded-lg p-6">
                  <button className="flex justify-between items-center w-full text-left font-['Space_Grotesk'] font-bold text-lg bg-transparent border-none text-[#f9f5f8] cursor-pointer">
                    <span>{q}</span>
                    <span className="material-symbols-outlined">expand_more</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-32 px-8">
          <div className="max-w-5xl mx-auto bg-[#ddffaf] rounded-lg p-16 md:p-24 text-center relative overflow-hidden">
            <div className="relative z-10">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-6xl font-bold text-[#3f6600] mb-8 tracking-tight">Stop guessing. Start promoting winners.</h2>
              <Link href="/signup" className="bg-[#0e0e10] text-[#f9f5f8] px-12 py-5 rounded-full font-['Space_Grotesk'] text-xl font-bold hover:opacity-90 transition-opacity active:scale-95 no-underline inline-block">
                Get Started Now
              </Link>
            </div>
            <div className="absolute top-0 right-0 w-64 h-64 bg-[#3f6600]/10 rounded-full blur-3xl -mr-32 -mt-32" />
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-[#3f6600]/10 rounded-full blur-3xl -ml-32 -mb-32" />
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-neutral-950">
        <div className="flex flex-col md:flex-row justify-between items-center max-w-7xl mx-auto gap-6 w-full py-12 px-8">
          <div className="text-white font-black text-lg">TikBase</div>
          <div className="flex gap-8 font-['IBM_Plex_Mono'] text-xs uppercase tracking-widest">
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Terms</a>
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Privacy</a>
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Contact</a>
          </div>
          <div className="font-['IBM_Plex_Mono'] text-xs uppercase tracking-widest text-neutral-500">
            2026 TikBase
          </div>
        </div>
      </footer>
    </div>
  );
}
