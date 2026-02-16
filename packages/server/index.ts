import { homedir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import {
  query,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { WebSocketServer, type WebSocket } from 'ws'

import { SERVER_PORT, WORKSPACE_DIR_NAME } from './const'
import { handleMessage } from './message-handler'
import { type QueryConfig, type WSOutputMessage } from './message-types'

const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)

// Single WebSocket connection (only one allowed)
let activeConnection: WebSocket | null = null

// Message queue
const messageQueue: SDKUserMessage[] = []

// Stream reference for interrupts
let activeStream: ReturnType<typeof query> | null = null

// Stored query configuration
let queryConfig: QueryConfig = {}

// Create an async generator that yields messages from the queue
async function* generateMessages() {
  while (true) {
    // Wait for messages in the queue
    while (messageQueue.length > 0) {
      const message = messageQueue.shift()
      yield message!
    }

    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Process messages from the SDK and send to WebSocket client
async function processMessages() {
  try {
    const options: Options = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      cwd: workspaceDirectory,
      stderr: data => {
        if (activeConnection) {
          const output: WSOutputMessage = {
            type: 'info',
            data,
          }
          activeConnection.send(JSON.stringify(output))
        }
      },
      ...queryConfig,
      ...(queryConfig.anthropicApiKey && {
        env: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: queryConfig.anthropicApiKey,
        },
      }),
    }

    console.info('Starting query with options', options)

    activeStream = query({
      prompt: generateMessages(),
      options,
    })

    for await (const message of activeStream) {
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: 'sdk_message',
          data: message,
        }
        activeConnection.send(JSON.stringify(output))
      }
    }
  } catch (error) {
    console.error('Error processing messages:', error)
    if (activeConnection) {
      const output: WSOutputMessage = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      activeConnection.send(JSON.stringify(output))
    }
  }
}

// Create HTTP server
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${SERVER_PORT}`)

  // Configuration endpoint
  if (url.pathname === '/config' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      try {
        queryConfig = JSON.parse(body) as QueryConfig
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, config: queryConfig }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
    return
  }

  // Get current configuration
  if (url.pathname === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config: queryConfig }))
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

// Create WebSocket server on /ws path
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', ws => {
  if (activeConnection) {
    const output: WSOutputMessage = {
      type: 'error',
      error: 'Server already has an active connection',
    }
    ws.send(JSON.stringify(output))
    ws.close()
    return
  }

  activeConnection = ws

  // Start processing messages when first connection is made
  if (!activeStream) {
    processMessages()
  }

  const output: WSOutputMessage = { type: 'connected' }
  ws.send(JSON.stringify(output))

  ws.on('message', async message => {
    await handleMessage(ws, message, {
      messageQueue,
      getActiveStream: () => activeStream,
    })
  })

  ws.on('close', () => {
    if (activeConnection === ws) {
      activeConnection = null
    }
  })
})

server.listen(SERVER_PORT, () => {
  console.log(`🚀 WebSocket server running on http://localhost:${SERVER_PORT}`)
  console.log(`   Config endpoint: http://localhost:${SERVER_PORT}/config`)
  console.log(`   WebSocket endpoint: ws://localhost:${SERVER_PORT}/ws`)
})
