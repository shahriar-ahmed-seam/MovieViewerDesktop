import React, { useEffect, useState } from 'react';

interface TitleBarProps {
  title?: string;
  onBack?: () => void;
  showBack?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({ title = 'MovieViewer', onBack, showBack }) => {
  const [isMax, setIsMax] = useState(false);

  useEffect(() => {
    window.electronAPI?.isMaximized?.().then(setIsMax);
  }, []);

  const handleMinimize = () => window.electronAPI?.minimizeWindow?.();
  const handleMaximize = () => {
    window.electronAPI?.maximizeWindow?.();
    setIsMax(!isMax);
  };
  const handleClose = () => window.electronAPI?.closeWindow?.();

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        {showBack && onBack && (
          <button 
            className="titlebar-btn" 
            onClick={onBack}
            title="Back (Esc / Backspace)"
            style={{ marginRight: 6 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
        )}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
        </svg>
        <span>{title}</span>
      </div>

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} title="Minimize">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} title={isMax ? "Restore" : "Maximize"}>
          {isMax ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="9" width="10" height="10" rx="1" />
              <polyline points="9 5 19 5 19 15" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          )}
        </button>
        <button className="titlebar-btn close" onClick={handleClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </header>
  );
};
