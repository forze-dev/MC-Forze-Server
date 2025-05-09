# Forze Server Core

## Overview

Forze Server Core is a comprehensive backend solution for Minecraft server management. This platform integrates player economy, chat engagement, server shop, and administration tools into a unified ecosystem, providing a seamless experience for both players and administrators with real-time functionality via WebSockets.

## Features

### Player Engagement & Economy
- Chat-Based Economy: Reward system (1 message = 1 point, up to 200 points daily)
- Referral System: Bonuses for inviting new players with progressive discounts
- Golden Hours: Scheduled 2x reward periods to boost engagement
- Weekly Leaderboard: Top player rankings with exclusive rewards

### Server Shop
- Resource Marketplace: Purchase in-game items and resources with earned points
- Dungeon Access System: Special passes for exclusive game content
- Discount Management: Player-specific discounts based on referral activity

### Real-Time Features
- Live Activity Feed: See server events and transactions as they happen
- Real-Time Notifications: Instant updates for purchases, rewards, and milestones
- Live Chat Integration: Direct communication between web interface and game
- Dynamic Leaderboards: Constantly updating player rankings
- Admin Live Dashboard: Real-time monitoring of server metrics and activity

### Server Management
- Admin Dashboard: Complete oversight of server activities and economy
- Player Analytics: Track engagement, in-game activity, and economic transactions
- Automatic Reward Distribution: Scheduled processes for leaderboard rewards

### Integration
- Telegram Bot: Real-time notifications and command interface
- Web Interface: Browser-based access to shop and player statistics
- Minecraft Server Plugin: Seamless in-game integration

## Technology Stack

- Backend: Node.js with Express
- Database: MySQL for persistent storage
- Caching: Redis for high-performance data operations
- Real-Time Communication: WebSockets with Socket.io
- Authentication: JWT-based secure access
- API: RESTful endpoints for standard services, WebSockets for real-time features

## Architecture

The system follows a modular architecture with these key components:

1. Core Service Layer: Base functionality and shared utilities
2. API Controllers: Endpoint management for different services
3. WebSocket Handlers: Real-time event processing and broadcasting
4. Database Services: Data persistence and retrieval
5. Integration Services: External system connections (Telegram, Minecraft)
6. Scheduled Tasks: Automated processes and maintenance
7. Event System: Pub/Sub architecture for internal communication

## Getting Started

### Prerequisites
- Node.js (v16+)
- MySQL (v8+)
- Redis (v6+)
- Telegram Bot Token
- Minecraft Server with plugin support

### Installation

1. Install dependencies
```bash
npm install
```

2. Configure environment variables
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Setup database
```bash
npm run db:setup
```

4. Start the development server
```bash
npm run dev
```

## Security

This project implements:
- Rate limiting for API endpoints and WebSocket connections
- Input validation and sanitization
- JWT-based authentication for both REST and WebSocket
- Role-based access control
- Protection against common web vulnerabilities
- WebSocket connection throttling

## License

This project is licensed under the MIT License - see the LICENSE file for details.