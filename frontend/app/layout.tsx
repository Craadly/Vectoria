import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
	title: 'Vectoria AI',
	description: 'AI-assisted vector logo generation',
}

export default function RootLayout({
	children,
}: {
	children: React.ReactNode
}) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}

