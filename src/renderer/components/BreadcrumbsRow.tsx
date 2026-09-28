import React from 'react';

export interface BreadcrumbItem {
  title: string;
  targetUrl: string;
}

interface BreadcrumbsRowProps {
  breadcrumbs: BreadcrumbItem[];
  onCrumbClick: (url: string) => void;
}

export const BreadcrumbsRow: React.FC<BreadcrumbsRowProps> = ({ breadcrumbs, onCrumbClick }) => {
  if (!breadcrumbs || breadcrumbs.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 16px',
        overflowX: 'auto',
        whiteSpace: 'nowrap',
        borderBottom: '1px solid var(--dark-outline-variant)',
        background: 'var(--dark-surface)'
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ flexShrink: 0, marginRight: 2 }}>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9 22 9 12 15 12 15 22"></polyline>
      </svg>

      {breadcrumbs.map((crumb, idx) => {
        const isLast = idx === breadcrumbs.length - 1;
        return (
          <React.Fragment key={crumb.targetUrl + idx}>
            <button
              onClick={() => onCrumbClick(crumb.targetUrl)}
              style={{
                background: isLast ? 'var(--elegant-primary-container)' : 'var(--dark-surface-card)',
                color: isLast ? 'var(--elegant-on-primary-container)' : 'var(--text-secondary)',
                border: '1px solid',
                borderColor: isLast ? 'var(--elegant-primary)' : 'var(--dark-outline-variant)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: isLast ? 700 : 500,
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                display: 'inline-flex',
                alignItems: 'center'
              }}
              onMouseEnter={(e) => {
                if (!isLast) {
                  e.currentTarget.style.color = 'var(--elegant-primary)';
                  e.currentTarget.style.borderColor = 'var(--elegant-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isLast) {
                  e.currentTarget.style.color = 'var(--text-secondary)';
                  e.currentTarget.style.borderColor = 'var(--dark-outline-variant)';
                }
              }}
            >
              {crumb.title}
            </button>
            {!isLast && (
              <span style={{ color: 'var(--text-muted)', fontSize: '12px', userSelect: 'none' }}>
                /
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
