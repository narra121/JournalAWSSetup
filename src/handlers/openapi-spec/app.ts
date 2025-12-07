import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

// Full embedded spec to avoid bundling issues
const embeddedSpec = `openapi: 3.0.3
info:
  title: Trading Journal API
  version: 0.1.0
  description: >-
    Serverless Trading Journal backend (Cognito + API Gateway + Lambda + DynamoDB + S3).
    All successful responses use the envelope { data, meta, error }. error is null on success.
servers:
  - url: https://xtut08sxga.execute-api.us-east-1.amazonaws.com/prod
    description: Example production endpoint (replace with real deployed URL)
  - url: /
    description: Relative (local or stage-injected)
security:
  - CognitoAuthorizer: []
components:
  securitySchemes:
    CognitoAuthorizer:
      type: http
      scheme: bearer
      bearerFormat: JWT
  schemas:
    Envelope:
      type: object
      required: [data, meta, error]
      properties:
        data: {}
        meta: { type: ["object", "null"], additionalProperties: true }
        error:
          anyOf:
            - $ref: '#/components/schemas/Error'
            - type: 'null'
    Error:
      type: object
      required: [code, message]
      properties:
        code: { type: string }
        message: { type: string }
        details: { type: array, items: { type: object } }
    Trade:
      type: object
      required: [userId, tradeId, symbol, side, quantity, openDate, status, createdAt, updatedAt]
      properties:
        userId: { type: string }
        tradeId: { type: string }
        symbol: { type: string }
        side: { type: string, enum: [BUY, SELL] }
        quantity: { type: number }
        openDate: { type: string, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        closeDate: { type: [string, 'null'], pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        entryPrice: { type: [number, 'null'] }
        exitPrice: { type: [number, 'null'] }
        stopLoss: { type: [number, 'null'] }
        takeProfit: { type: [number, 'null'] }
        pnl: { type: [number, 'null'] }
        netPnl: { type: [number, 'null'] }
        commission: { type: [number, 'null'] }
        fees: { type: [number, 'null'] }
        riskAmount: { type: [number, 'null'] }
        riskRewardRatio: { type: [number, 'null'] }
        setupType: { type: [string, 'null'] }
        timeframe: { type: [string, 'null'] }
        marketCondition: { type: [string, 'null'] }
        tradingSession: { type: [string, 'null'] }
        tradeGrade: { type: [string, 'null'], enum: [A,B,C,D,F,null] }
        confidence: { type: [number, 'null'], minimum: 0, maximum: 10 }
        setupQuality: { type: [number, 'null'], minimum: 0, maximum: 10 }
        execution: { type: [number, 'null'], minimum: 0, maximum: 10 }
        emotionalState: { type: [string, 'null'] }
        psychology:
          type: object
          additionalProperties: false
          properties:
            greed: { type: boolean }
            fear: { type: boolean }
            fomo: { type: boolean }
            revenge: { type: boolean }
            overconfidence: { type: boolean }
            patience: { type: boolean }
        preTradeNotes: { type: [string, 'null'] }
        postTradeNotes: { type: [string, 'null'] }
        mistakes: { type: array, items: { type: string } }
        lessons: { type: array, items: { type: string } }
        newsEvents: { type: array, items: { type: string } }
        economicEvents: { type: array, items: { type: string } }
        outcome: { type: string, enum: [TP, SL, PARTIAL, BREAKEVEN] }
        tags: { type: array, items: { type: string } }
        images:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              url: { type: string }
              timeframe: { type: [string, 'null'] }
              description: { type: [string, 'null'] }
        createdAt: { type: string }
        updatedAt: { type: string }
    TradeCreateRequest:
      allOf:
        - $ref: '#/components/schemas/TradeCreateCore'
    TradeCreateCore:
      type: object
      required: [symbol, side, quantity, openDate]
      additionalProperties: false
      properties:
        symbol: { type: string, minLength: 1 }
        side: { type: string, enum: [BUY, SELL] }
        quantity: { type: number, minimum: 0.0000001 }
        openDate: { type: string, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        closeDate: { type: [string, 'null'], pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        entryPrice: { type: [number, 'null'], minimum: 0 }
        exitPrice: { type: [number, 'null'], minimum: 0 }
        stopLoss: { type: [number, 'null'], minimum: 0 }
        takeProfit: { type: [number, 'null'], minimum: 0 }
        commission: { type: [number, 'null'], minimum: 0 }
        fees: { type: [number, 'null'], minimum: 0 }
        riskAmount: { type: [number, 'null'], minimum: 0 }
        setupType: { type: [string, 'null'], maxLength: 64 }
        timeframe: { type: [string, 'null'], maxLength: 32 }
        marketCondition: { type: [string, 'null'], maxLength: 64 }
        tradingSession: { type: [string, 'null'], maxLength: 32 }
        tradeGrade: { type: [string, 'null'], enum: [A,B,C,D,F,null] }
        confidence: { type: [number, 'null'], minimum: 0, maximum: 10 }
        setupQuality: { type: [number, 'null'], minimum: 0, maximum: 10 }
        execution: { type: [number, 'null'], minimum: 0, maximum: 10 }
        emotionalState: { type: [string, 'null'], maxLength: 128 }
        psychology:
          type: object
          additionalProperties: false
          properties:
            greed: { type: boolean }
            fear: { type: boolean }
            fomo: { type: boolean }
            revenge: { type: boolean }
            overconfidence: { type: boolean }
            patience: { type: boolean }
        preTradeNotes: { type: [string, 'null'], maxLength: 4000 }
        postTradeNotes: { type: [string, 'null'], maxLength: 4000 }
        mistakes: { type: array, items: { type: string, maxLength: 64 }, maxItems: 50 }
        lessons: { type: array, items: { type: string, maxLength: 64 }, maxItems: 50 }
        newsEvents: { type: array, items: { type: string, maxLength: 128 }, maxItems: 50 }
        economicEvents: { type: array, items: { type: string, maxLength: 128 }, maxItems: 50 }
        outcome: { type: [string, 'null'], enum: [TP, SL, PARTIAL, BREAKEVEN, null] }
        tags: { type: array, items: { type: string, maxLength: 32 }, maxItems: 50 }
        images:
          type: array
          maxItems: 20
          items:
            type: object
            additionalProperties: false
            properties:
              id: { type: string }
              url: { type: string }
              base64Data: { type: string, pattern: '^data:image/' }
              timeframe: { type: [string, 'null'], maxLength: 32 }
              description: { type: [string, 'null'], maxLength: 256 }
    TradeBulkCreateRequest:
      type: object
      required: [items]
      properties:
        items:
          type: array
          minItems: 1
          maxItems: 50
          items: { $ref: '#/components/schemas/TradeCreateCore' }
    AuthSignupRequest:
      type: object
      required: [email, password]
      properties:
        email: { type: string, format: email }
        password: { type: string, minLength: 12 }
    AuthConfirmSignupRequest:
      type: object
      required: [email, code]
      properties:
        email: { type: string, format: email }
        code: { type: string, minLength: 1 }
    AuthLoginRequest:
      type: object
      required: [email, password]
      properties:
        email: { type: string, format: email }
        password: { type: string, minLength: 1 }
    AuthRefreshRequest:
      type: object
      required: [refreshToken]
      properties:
        refreshToken: { type: string, minLength: 1 }
    AuthForgotPasswordRequest:
      type: object
      required: [email]
      properties:
        email: { type: string, format: email }
    AuthConfirmForgotPasswordRequest:
      type: object
      required: [email, code, password]
      properties:
        email: { type: string, format: email }
        code: { type: string, minLength: 1 }
        password: { type: string, minLength: 6, maxLength: 18 }
    ExtractTradesRequest:
      type: object
      required: [imageBase64]
      properties:
        imageBase64: { type: string, description: Base64 encoded image. May include data URI prefix. }
    ExtractedTrade:
      type: object
      required: [symbol, side, quantity, openDate, closeDate, entryPrice, exitPrice, fee, swap, pnl]
      properties:
        symbol: { type: string }
        side: { type: string, enum: [BUY, SELL] }
        quantity: { type: number }
        openDate: { type: string, format: date-time }
        closeDate: { type: string, format: date-time }
        entryPrice: { type: number }
        exitPrice: { type: number }
        fee: { type: number }
        swap: { type: number }
        pnl: { type: number }
paths:
  /trades:
    get:
      summary: List trades
      tags: [Trades]
      parameters:
        - in: query
          name: symbol
          schema: { type: string }
        - in: query
          name: status
          schema: { type: string }
        - in: query
          name: tag
          schema: { type: string }
        - in: query
          name: startDate
          schema: { type: string, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        - in: query
          name: endDate
          schema: { type: string, pattern: '^\\\\d{4}-\\\\d{2}-\\\\d{2}$' }
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 100 }
        - in: query
          name: nextToken
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/Envelope'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          items: { type: array, items: { $ref: '#/components/schemas/Trade' } }
                          nextToken: { type: [string, 'null'] }
    post:
      summary: Create trade (single or bulk)
      tags: [Trades]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/TradeCreateRequest'
                - $ref: '#/components/schemas/TradeBulkCreateRequest'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Envelope' }
        '400':
          description: Validation Error
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Envelope' }
  /trades/{tradeId}:
    get:
      summary: Get trade by id
      tags: [Trades]
      parameters:
        - in: path
          name: tradeId
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Envelope' }
        '404':
          description: Not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Envelope' }
    put:
      summary: Update trade
      tags: [Trades]
      parameters:
        - in: path
          name: tradeId
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/TradeCreateRequest' }
      responses:
        '200': { description: Updated, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
    delete:
      summary: Delete trade
      tags: [Trades]
      parameters:
        - in: path
          name: tradeId
          required: true
          schema: { type: string }
      responses:
        '204': { description: Deleted }
        '404': { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /stats:
    get:
      summary: Get aggregate stats
      tags: [Stats]
      responses:
        '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /upload-url:
    get:
      summary: Generate presigned upload URL (if implemented)
      tags: [Images]
      responses:
        '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/signup:
    post:
      security: []
      summary: Sign up user
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthSignupRequest' }
      responses:
        '200': { description: Signed up, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/confirm-signup:
    post:
      security: []
      summary: Confirm sign up
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthConfirmSignupRequest' }
      responses:
        '200': { description: Confirmed, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/login:
    post:
      security: []
      summary: Login
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthLoginRequest' }
      responses:
        '200': { description: Tokens, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/refresh:
    post:
      security: []
      summary: Refresh tokens
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthRefreshRequest' }
      responses:
        '200': { description: Tokens, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/forgot-password:
    post:
      security: []
      summary: Forgot password
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthForgotPasswordRequest' }
      responses:
        '200': { description: Code sent, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/confirm-forgot-password:
    post:
      security: []
      summary: Confirm forgot password
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AuthConfirmForgotPasswordRequest' }
      responses:
        '200': { description: Password reset, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/account:
    delete:
      summary: Delete account and all data
      tags: [Auth]
      responses:
        '200': { description: Deleted, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /auth/export:
    get:
      summary: Export account data (trades + stats)
      tags: [Auth]
      responses:
        '200': { description: Export file, content: { application/json: { schema: { } } } }
  /auth/logout-all:
    post:
      summary: Global sign out (revoke sessions)
      tags: [Auth]
      responses:
        '200': { description: Signed out, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
  /trades/extract:
    post:
      summary: Extract structured trades from an uploaded trade history image using Gemini.
      tags: [Trades]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ExtractTradesRequest' }
      responses:
        '200':
          description: Extraction succeeded
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/Envelope'
                  - type: object
                    properties:
                      data:
                        type: object
                        properties:
                          items: { type: array, items: { $ref: '#/components/schemas/ExtractedTrade' } }
                      meta:
                        type: object
                        description: Execution metadata for extraction.
                        properties:
                          elapsedMs: { type: integer, description: Milliseconds end-to-end latency }
                          parseSteps: { type: array, items: { type: string }, description: Heuristic parsing steps applied to model output }
              examples:
                success:
                  summary: Successful extraction
                  value:
                    data:
                      items:
                        - symbol: XAUUSD
                          side: SELL
                          quantity: 0.2
                          openDate: '2023-08-21T17:46:25'
                          closeDate: '2023-08-21T18:15:15'
                          entryPrice: 3343.58
                          exitPrice: 3338.78
                          fee: -0.8
                          swap: 0
                          pnl: 95.2
                    meta:
                      elapsedMs: 12010
                      parseSteps: [ 'Stripped markdown code fence', 'Detected array boundaries directly' ]
                    error: null
        '400': { description: Bad request, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
        '413': { description: Image too large, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
        '502': { description: Upstream model error, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
        '504': { description: Upstream model timeout, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
        '500': { description: Extraction error, content: { application/json: { schema: { $ref: '#/components/schemas/Envelope' } } } }
`;

let cached: string | null = embeddedSpec;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  try {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      },
      body: cached || ''
    };
  } catch (e) {
    console.error('Failed to serve OpenAPI spec', e);
    return { statusCode: 500, body: 'spec error' };
  }
};
