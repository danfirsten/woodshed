import { useAppStore } from '../state/store'
import { goToLibrary, goToRecord } from '../app/controller'
import { ErrorBanner } from './components/ErrorBanner'
import { ThemeToggle } from './components/ThemeToggle'
import { LibraryIcon, MicIcon } from './components/Icons'
import { RecordView } from './record/RecordView'
import { ReviewView } from './review/ReviewView'
import { LibraryView } from './library/LibraryView'
import './App.css'

function TopBar() {
  const view = useAppStore((s) => s.view)
  const recording = useAppStore((s) => s.recordingStatus !== 'idle')

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <button type="button" className="wordmark" onClick={goToRecord} aria-label="Woodshed — go to record">
          <span className="wordmark__mark" aria-hidden="true">
            <span className="wordmark__ring" />
          </span>
          <span className="wordmark__text">Woodshed</span>
        </button>

        <nav className="topbar__nav" aria-label="Main">
          <button
            type="button"
            className="navlink"
            onClick={goToRecord}
            aria-current={view === 'record' ? 'page' : undefined}
          >
            <MicIcon size={16} />
            <span>Record</span>
            {recording && <span className="navlink__live" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="navlink"
            onClick={goToLibrary}
            aria-current={view === 'library' ? 'page' : undefined}
          >
            <LibraryIcon size={16} />
            <span>Library</span>
          </button>
        </nav>

        <ThemeToggle />
      </div>
    </header>
  )
}

export default function App() {
  const view = useAppStore((s) => s.view)

  return (
    <div className="app">
      <TopBar />
      <ErrorBanner />
      <main className="app__main">
        {view === 'record' && <RecordView />}
        {view === 'review' && <ReviewView />}
        {view === 'library' && <LibraryView />}
      </main>
      <footer className="app__footer">
        <p>Woodshed runs entirely in your browser. Nothing leaves this device.</p>
      </footer>
    </div>
  )
}
