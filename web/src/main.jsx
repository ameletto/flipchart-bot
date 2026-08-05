import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Board } from './Board.jsx'
import './styles.css'

// The token rides in the URL fragment, which browsers never send to a server — it stays
// out of access logs, referrers and proxies. Read it once, then wipe it from the address
// bar so a shared screenshot or a glance over a shoulder doesn't hand it to anyone else.
const token = new URLSearchParams(location.hash.slice(1)).get('t')
if (token) history.replaceState(null, '', location.pathname)

const boardId = location.pathname.split('/').filter(Boolean).pop()

createRoot(document.getElementById('root')).render(
	<StrictMode>
		<Board boardId={boardId} token={token} />
	</StrictMode>
)
