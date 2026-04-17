export function VideoShowcase() {
  return (
    <section className="bg-muted px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="animate-on-scroll">
          <div className="overflow-hidden rounded-xl shadow-2xl">
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
    </section>
  );
}
