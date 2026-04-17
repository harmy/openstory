import { GitHubIcon } from '@/components/icons/github-icon';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';

export const OgImageGitHub: React.FC = () => {
  return (
    <div className="flex h-[630px] w-[1200px] flex-col items-center justify-center bg-white p-20">
      <div className="flex flex-col items-center gap-10 text-center">
        <div className="flex items-center gap-6 text-black">
          <OpenStoryLogo className="h-16 w-auto" />
          <span className="text-3xl text-black/30">/</span>
          <GitHubIcon className="size-16" />
        </div>

        <h1 className="font-heading text-[5.5rem] font-bold tracking-tight leading-[1] text-black">
          Open source
          <br />
          video generation
        </h1>

        <p className="font-mono text-2xl text-black/60">
          github.com/openstory-so/openstory
        </p>
      </div>
    </div>
  );
};
