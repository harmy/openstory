import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { HeroCanvas } from './hero-canvas';

export function HeroSection() {
  return (
    <section className="relative flex min-h-svh flex-col justify-center overflow-hidden bg-black">
      <HeroCanvas />

      <div className="relative z-10 px-6">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_1fr] lg:gap-14">
          <div className="flex flex-col gap-5 md:gap-6">
            <h1 className="hero-reveal hero-reveal-delay-1 font-heading text-7xl font-bold tracking-tighter leading-[0.95] text-white md:text-7xl lg:text-8xl">
              Open Video
              <br />
              <span className="text-editorial">Generation.</span>
            </h1>

            <div className="hero-reveal hero-reveal-delay-2 flex items-center gap-3">
              <span className="h-px w-8 bg-gradient-to-r from-transparent to-white/40" />
              <span className="text-xs font-medium tracking-[0.15em] text-white/50 uppercase">
                Open Source AI Video Production
              </span>
              <span className="h-px w-8 bg-gradient-to-l from-transparent to-white/40" />
            </div>

            <p className="hero-reveal hero-reveal-delay-3 max-w-md text-base text-white/60 sm:text-lg md:text-xl">
              Describe an idea, cast your characters, and generate a multi-scene
              video with the best AI&nbsp;models.
            </p>

            <div className="hero-reveal hero-reveal-delay-4 flex justify-center pt-2 lg:justify-start">
              <div className="group relative inline-block rounded-full">
                {/* Animated gradient glow */}
                <span
                  className="absolute -inset-[2px] rounded-full opacity-60 blur-md transition-all duration-500 group-hover:opacity-100 group-hover:blur-lg"
                  style={{
                    background:
                      'conic-gradient(from var(--glow-angle, 0deg), #e8937a, #c9a06c, #e8937a, #d4838f, #e8937a)',
                    animation: 'glow-spin 4s linear infinite',
                  }}
                />
                {/* Gradient border ring */}
                <span
                  className="absolute -inset-[1px] rounded-full opacity-80 transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    background:
                      'conic-gradient(from var(--glow-angle, 0deg), #e8937a, #c9a06c, #e8937a, #d4838f, #e8937a)',
                    animation: 'glow-spin 4s linear infinite',
                  }}
                />
                <Button
                  asChild
                  size="lg"
                  className="relative rounded-full bg-black px-8 text-white hover:bg-black/80"
                >
                  <Link to="/login">Start Now</Link>
                </Button>
              </div>
            </div>
          </div>

          <div className="hero-reveal hero-reveal-delay-3">
            <div className="overflow-hidden rounded-xl shadow-2xl shadow-white/5">
              <video
                autoPlay
                muted
                loop
                playsInline
                className="aspect-video w-full object-cover"
              >
                <source
                  src="https://assets.openstory.so/videos/hero-loop.mp4"
                  type="video/mp4"
                />
              </video>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
