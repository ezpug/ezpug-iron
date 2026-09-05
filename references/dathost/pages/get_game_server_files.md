---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# List files on gameserver

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/game-servers/{server_id}/files": {
      "get": {
        "operationId": "get_game_server_files",
        "parameters": [
          {
            "description": "If true, only files added by the user will be shown, default is all files",
            "in": "query",
            "name": "hide_default_files",
            "schema": {
              "type": "boolean"
            }
          },
          {
            "description": "If true, also return files that has been deleted by the user",
            "in": "query",
            "name": "include_deleted_files",
            "schema": {
              "type": "boolean"
            }
          },
          {
            "description": "Path to use as root, leave empty to get all files",
            "in": "query",
            "name": "path",
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success"
          },
          "404": {
            "description": "A server with this id was not found"
          }
        },
        "summary": "List files on gameserver",
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