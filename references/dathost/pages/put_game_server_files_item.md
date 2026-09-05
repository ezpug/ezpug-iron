---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Move a file/directory on a game server

Moves path to destination, the paths are counted from the root node
as seen in the file manager in the control panel,
i.e. to delete csgo/cfg/server.cfg the path would be cfg/server.cfg.

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
      ],
      "put": {
        "description": "Moves path to destination, the paths are counted from the root node\nas seen in the file manager in the control panel,\ni.e. to delete csgo/cfg/server.cfg the path would be cfg/server.cfg.",
        "operationId": "put_game_server_files_item",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "destination": {
                    "description": "Destination path",
                    "type": "string"
                  }
                },
                "required": [
                  "destination"
                ]
              }
            }
          },
          "required": true
        },
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "description": "Cannot move file into itself"
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "Move a file/directory on a game server",
        "tags": [
          "Game Servers > File Management"
        ]
      }
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