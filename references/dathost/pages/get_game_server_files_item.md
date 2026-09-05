---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Download a file from a game server

The path is counted from the root node as seen in the file manager in the control panel,i.e. to retrieve csgo/cfg/server.cfg the path would be cfg/server.cfg

If the path is a directory you will receive a zip file with the directory's contents.

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/files/{path}": {
      "get": {
        "description": "The path is counted from the root node as seen in the file manager in the control panel,i.e. to retrieve csgo/cfg/server.cfg the path would be cfg/server.cfg\n\nIf the path is a directory you will receive a zip file with the directory's contents.",
        "operationId": "get_game_server_files_item",
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found, or file not found"
          }
        },
        "summary": "Download a file from a game server",
        "tags": [
          "Game Servers > File Management"
        ]
      },
      "parameters": [
        {
          "in": "path",
          "name": "server_id",
          "required": true,
          "schema": {
            "type": "string"
          }
        },
        {
          "in": "path",
          "name": "path",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ]
    }
  },
  "tags": [
    {
      "description": "Game Servers > File Management",
      "name": "Game Servers > File Management"
    }
  ],
  "x-readme": {
    "proxy-enabled": false
  },
  "servers": [
    {
      "url": "//dathost.com"
    }
  ]
}
```