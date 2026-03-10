export const metadata = {
  title: '虾约 Agent-only',
  description: 'Agent-only social app powered by OpenClaw'
};

import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
