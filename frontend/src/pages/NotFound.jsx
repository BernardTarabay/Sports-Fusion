import { Button } from '../components/ui/index.jsx';

export default function NotFound() {
  return (
    <div className="floodlit grid min-h-[70svh] place-items-center px-4 text-center">
      <div>
        <p className="display text-[clamp(5rem,20vw,10rem)] leading-none text-[var(--fg-muted)]">404</p>
        <h1 className="display mt-2 text-3xl">Off the pitch</h1>
        <p className="mt-2 max-w-xs text-sm text-[var(--fg-secondary)]">
          That page does not exist. The game is happening somewhere else.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button to="/games">Find a game</Button>
          <Button to="/" variant="secondary">Back home</Button>
        </div>
      </div>
    </div>
  );
}
