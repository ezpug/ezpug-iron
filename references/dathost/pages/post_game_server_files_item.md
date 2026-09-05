---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Upload a file to a game server

The path is counted from the root node as seen in the file manager in the control panel,i.e. to write csgo/cfg/server.cfg the path would be cfg/server.cfg, if the path ends with / a directory will be created and the file parameter will be ignored.

There is a upload limit of 100MB on dathost.com, use FTP to upload bigger files.

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
      "post": {
        "description": "The path is counted from the root node as seen in the file manager in the control panel,i.e. to write csgo/cfg/server.cfg the path would be cfg/server.cfg, if the path ends with / a directory will be created and the file parameter will be ignored.\n\nThere is a upload limit of 100MB on dathost.com, use FTP to upload bigger files.",
        "operationId": "post_game_server_files_item",
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "file": {
                    "description": "The file to be uploaded as a multipart/form-data body <a target=\"_blank\" href=\"        http://docs.python-requests.org/en/latest/user/quickstart/#post-a-multipart-encoded-file\">        (Python example)</a>, if not provided an empty file/directory will be created",
                    "type": "string",
                    "format": "binary"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "description": "Path is a directory"
          },
          "404": {
            "description": "A server with this id was not found"
          },
          "507": {
            "description": "Your disk quota of 30GB per server (excluding base installation) has been exceeded"
          }
        },
        "summary": "Upload a file to a game server",
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