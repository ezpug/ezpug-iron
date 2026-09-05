---
updatedAt: 2026-06-12T13:40:46.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Get the current account

# OpenAPI definition

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "API",
    "version": "1.0"
  },
  "paths": {
    "/api/0.1/account": {
      "get": {
        "operationId": "get_account",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AccountOutput"
                }
              }
            }
          }
        },
        "summary": "Get the current account",
        "tags": [
          "Account"
        ]
      }
    }
  },
  "tags": [
    {
      "description": "Account",
      "name": "Account"
    }
  ],
  "x-readme": {
    "proxy-enabled": false
  },
  "servers": [
    {
      "url": "//dathost.com"
    }
  ],
  "components": {
    "schemas": {
      "AccountOutput": {
        "properties": {
          "accepted_terms_of_service_version": {
            "description": "Accepted ToS version",
            "type": "integer"
          },
          "affiliate": {
            "description": "True if this account is an affiliate",
            "type": "boolean"
          },
          "autorefill_amount": {
            "type": "number"
          },
          "autorefill_below": {
            "type": "number"
          },
          "confirmed_at": {
            "description": "Timestamp of email confirmation",
            "type": "integer"
          },
          "credits": {
            "description": "Number of credits left",
            "type": "number"
          },
          "disabled_notification_types": {
            "items": {
              "description": "Disabled notification types",
              "enum": [
                "SUBSCRIPTION_RENEWAL_SUCCESS_EMAIL",
                "AUTOREFILL_SUCCESS_EMAIL",
                "LOW_CREDITS_WARNING_EMAIL"
              ],
              "example": "SUBSCRIPTION_RENEWAL_SUCCESS_EMAIL",
              "type": "string"
            },
            "type": "array"
          },
          "email": {
            "description": "Account email",
            "type": "string"
          },
          "first_month_discount_percentage": {
            "description": "Discount percentage for the first month of a subscription",
            "type": "integer"
          },
          "gravatar_url": {
            "description": "Gravatar URL",
            "type": "string"
          },
          "id": {
            "description": "Account ID",
            "type": "string"
          },
          "lifetime_hourly_discount_percentage": {
            "description": "Account hourly discount percentage",
            "type": "integer"
          },
          "lifetime_subscription_discount_percentage": {
            "description": "Account subscription discount percentage",
            "type": "integer"
          },
          "marketing_emails_enabled": {
            "type": "boolean"
          },
          "roles": {
            "description": "Special roles at dathost.com",
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "seconds_left": {
            "description": "Approximately seconds the credits will last with current usage. Returns null if no servers are on",
            "type": "integer"
          },
          "subscription_pay_with_credits": {
            "description": "If true, try to pay subscription with credits first",
            "type": "boolean"
          },
          "time_left": {
            "description": "Human readable approximate of the time the credits will last with current usage, for seconds see seconds_left",
            "type": "string"
          },
          "trial": {
            "description": "An account is considered trial when no payments has been made",
            "type": "boolean"
          }
        },
        "required": [
          "credits",
          "email",
          "gravatar_url",
          "id"
        ],
        "type": "object",
        "additionalProperties": false
      }
    }
  }
}
```