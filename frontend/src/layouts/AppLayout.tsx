import type { ReactNode } from 'react';
import Navigation from '../components/Navigation';

type AppLayoutProps = { children: ReactNode };

export default function AppLayout({ children }: AppLayoutProps) {
  return (
    <>
      <header className="app-header">
        <div className="app-brand">Auto Labeling</div>
        <Navigation />
      </header>
      {children}
    </>
  );
}
