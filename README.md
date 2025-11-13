# VX API SERVER

This is the backend API server for VX, built using Cloudflare Workers. It handles user authentication, data storage, and serves as the intermediary between the VX frontend and various third-party services.

Host: api.varius.technology

Connect API with...
- curl
- sdk (coming soon)

## swagger ui
https://api.varius.technology/swagger/vx

## Authentication

URL format:

GitHub Sign-In with Redirect
```
https://api.varius.technology/auth?redirect_url={YOUR_REDIRECT_URL}
```

Authorized User Data Response Format
```bash
curl -X GET https://api.varius.technology/users/<USER_ID>
```

## Create Wallet 
on local(or your server)
```bash
```

on chain
```bash
```

## Get Wallet Info 
### from Chains
```bash
```

## Payment

> Here is explain how to use payment API. but not yet make it. Sorry... ( ; ; ) <= omg! he is cry!