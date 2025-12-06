This file is an **AWS SAM (Serverless Application Model)** template. It is a configuration file written in YAML.

When you run the command `sam deploy`, AWS reads this file and builds your entire backend infrastructure (Databases, API Gateways, Authentication, and Code execution) exactly as described here.

Here is the fully annotated code. I have added **links** that allow you to jump between where a variable is **used** and where it is **created**.

---

### **Table of Contents & Legend**
*   **[Parameters](#section-parameters)**: Inputs you give when deploying (like environment names).
*   **[Globals](#section-globals)**: Settings that apply to all functions.
*   **[Conditions](#section-conditions)**: Logic to decide what to build.
*   **[Resources](#section-resources)**: The actual things created (Tables, Buckets, Functions).
    *   [Cognito (Auth)](#resource-cognito)
    *   [S3 (Images)](#resource-s3)
    *   [DynamoDB (Database)](#resource-dynamodb)
    *   [HttpApi (Gateway)](#resource-httpapi)
    *   [Lambdas (Code)](#resource-lambdas)

---

### **The Annotated Code**

```yaml
# -------------------------------------------------------------------------
# HEADER
# -------------------------------------------------------------------------
AWSTemplateFormatVersion: '2010-09-09'
# ^ REQUIRED: Tells AWS which version of the CloudFormation syntax to use.
#   It ensures the parser reads the file correctly.

Transform: AWS::Serverless-2016-10-31
# ^ CRITICAL: This line turns this file from standard "CloudFormation" into "SAM".
#   It allows us to use shortcuts like "AWS::Serverless::Function" which
#   AWS automatically expands into complex permissions and roles behind the scenes.

Description: Serverless Trading Journal Backend (Cognito + HTTP API + Lambda + DynamoDB + S3)
# ^ Just a text string. It appears in the AWS CloudFormation Console to help you identify this stack.

# -------------------------------------------------------------------------
# <a id="section-globals"></a>GLOBALS
# These settings are automatically copied into every "AWS::Serverless::Function"
# defined later in the Resources section.
# -------------------------------------------------------------------------
Globals:
  Function:
    Runtime: nodejs20.x
    # ^ Tells AWS to use Node.js version 20 to run your JavaScript code.

    Timeout: 10
    # ^ Safety: If code runs longer than 10 seconds, force stop it. Prevents infinite loops costing money.

    MemorySize: 256
    # ^ Power: Allocate 256MB of RAM to the function. (More RAM = faster CPU in AWS Lambda).

    Tracing: Active
    # ^ Advanced: Enables AWS X-Ray. It tracks requests as they jump from API -> Lambda -> Database
    #   so you can see a visual map of performance bottlenecks.

    Environment:
      Variables:
        # These variables are injected into your Node.js code (process.env.VARIABLE_NAME).

        # LOGIC: If "CreateNewDataResources" is True, use the "TradesTable" resource name.
        #        If False, use the "ExistingTradesTableName" parameter provided by the user.
        # [LINK]: Jumps to Condition definition below -> [CreateNewDataResources](#condition-createnew)
        # [LINK]: Jumps to Resource definition below -> [TradesTable](#resource-tradestable)
        # [LINK]: Jumps to Parameter definition below -> [ExistingTradesTableName](#param-existing-trades)
        TRADES_TABLE: !If [CreateNewDataResources, !Ref TradesTable, !Ref ExistingTradesTableName]

        # Same logic for the Stats table.
        # [LINK]: [TradeStatsTable](#resource-tradestats), [ExistingTradeStatsTableName](#param-existing-stats)
        TRADE_STATS_TABLE: !If [CreateNewDataResources, !Ref TradeStatsTable, !Ref ExistingTradeStatsTableName]

        # Same logic for the S3 Bucket.
        # [LINK]: [ImagesBucket](#resource-imagesbucket), [ExistingImagesBucketName](#param-existing-bucket)
        IMAGES_BUCKET: !If [CreateNewDataResources, !Ref ImagesBucket, !Ref ExistingImagesBucketName]

        # Same logic for Rate Limiting table.
        # [LINK]: [AuthRateLimitTable](#resource-ratelimittable), [ExistingAuthRateLimitTableName](#param-existing-ratelimit)
        RATE_LIMIT_TABLE: !If [CreateNewDataResources, !Ref AuthRateLimitTable, !Ref ExistingAuthRateLimitTableName]

        # !Ref returns the physical ID (e.g., "us-east-1_xxxx") of the User Pool created below.
        # [LINK]: [UserPool](#resource-userpool)
        USER_POOL_ID: !Ref UserPool

        # !Ref returns the Client ID (e.g., "3n4b5...") of the App Client created below.
        # [LINK]: [UserPoolClient](#resource-userpoolclient)
        USER_POOL_CLIENT_ID: !Ref UserPoolClient

        # Advanced: Tells the AWS SDK in Node.js to keep the TCP connection open.
        # This makes subsequent database requests much faster (saves ~50ms per request).
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1'

# -------------------------------------------------------------------------
# <a id="section-parameters"></a>PARAMETERS
# Values you provide in the command line (CLI) when deploying.
# Example: sam deploy --parameter-overrides StageName=dev
# -------------------------------------------------------------------------
Parameters:
  StageName:
    Type: String
    Default: prod
    Description: Deployment stage (lowercase) used in resource names (e.g., prod, dev, test).
    AllowedPattern: '^[a-z0-9-]+$' # Regex validation to ensure no weird characters.

  ApiVersion:
    Type: String
    Default: v1
    Description: API version prefix. Useful if you ever need to release v2 without breaking v1.

  LogRetentionDays:
    Type: Number
    Default: 14
    AllowedValues: [1,3,5,7,14,30,60,90,120,150,180,365,400,545,731,1827,3653]
    Description: How long to keep server logs. 14 days is a good balance of history vs. cost.

  GeminiApiKeyParamName:
    Type: String
    Default: /trading-journal/geminiApiKey
    Description: SECURITY: We do NOT put the API Key here. We put the *path* to the
                 AWS Systems Manager (SSM) Parameter Store where the key is safely hidden.

  UseExistingResources:
    Type: String
    Default: "false"
    AllowedValues: ["true","false"]
    Description: "Feature Flag". If "true", we skip creating tables/buckets and use old ones.
                 Useful for redeploying code without wiping out your database.

  # <a id="param-existing-trades"></a>
  ExistingTradesTableName:
    Type: String
    Default: ""
    Description: If UseExistingResources=true, you must paste the name of your old table here.

  # <a id="param-existing-stats"></a>
  ExistingTradeStatsTableName:
    Type: String
    Default: ""
    Description: If UseExistingResources=true, paste old stats table name here.

  # <a id="param-existing-bucket"></a>
  ExistingImagesBucketName:
    Type: String
    Default: ""
    Description: If UseExistingResources=true, paste old bucket name here.

  # <a id="param-existing-ratelimit"></a>
  ExistingAuthRateLimitTableName:
    Type: String
    Default: ""
    Description: If UseExistingResources=true, paste old rate limit table name here.

# -------------------------------------------------------------------------
# <a id="section-conditions"></a>CONDITIONS
# Simple boolean logic used to toggle resources on or off.
# -------------------------------------------------------------------------
Conditions:
  # <a id="condition-createnew"></a>
  CreateNewDataResources: !Equals [!Ref UseExistingResources, "false"]
  # ^ Logic: Checks if the parameter "UseExistingResources" equals "false".
  #   Returns: TRUE if we should build new tables. FALSE if we should not.

# -------------------------------------------------------------------------
# <a id="section-resources"></a>RESOURCES
# The actual infrastructure components AWS will build.
# -------------------------------------------------------------------------
Resources:

  # --- <a id="resource-cognito"></a>Authentication (Cognito) ---

  # <a id="resource-userpool"></a>
  UserPool:
    Type: AWS::Cognito::UserPool
    Properties:
      # Naming the pool dynamically using the StageName parameter (e.g., TradingJournalUserPool-prod).
      UserPoolName: !Sub TradingJournalUserPool-${StageName}
      
      # Users log in with email, not a custom username.
      UsernameAttributes: [email]
      
      # AWS sends an email with a code to verify the email address automatically.
      AutoVerifiedAttributes: [email]
      
      Policies:
        PasswordPolicy:
          MinimumLength: 6
          RequireLowercase: true
          RequireNumbers: true
          RequireSymbols: true
          RequireUppercase: true

  # <a id="resource-userpoolclient"></a>
  UserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      # links this Client to the Pool defined above.
      UserPoolId: !Ref UserPool 
      ClientName: web
      
      # SECURITY: False because a Javascript frontend cannot keep a secret hidden.
      GenerateSecret: false 
      
      ExplicitAuthFlows:
        - ALLOW_USER_PASSWORD_AUTH # Standard login
        - ALLOW_REFRESH_TOKEN_AUTH # Allows staying logged in without re-entering password
      
      PreventUserExistenceErrors: ENABLED
      # ^ SECURITY: If someone tries to login with a fake email, don't say "User not found".
      #   Say "Login failed". This prevents hackers from scanning your database for valid emails.
      
      SupportedIdentityProviders: [COGNITO]
      CallbackURLs: ["http://localhost:3000/"] # Where to redirect after login (Dev only setting usually)
      LogoutURLs: ["http://localhost:3000/"]
      AllowedOAuthFlowsUserPoolClient: false

  # --- <a id="resource-s3"></a>Storage (S3) ---

  # <a id="resource-imagesbucket"></a>
  ImagesBucket:
    Type: AWS::S3::Bucket
    Condition: CreateNewDataResources 
    # ^ Only create this if the condition is TRUE.
    
    DeletionPolicy: Retain 
    # ^ SAFETY: If you delete this stack, DO NOT delete the bucket. Keep the data.
    
    UpdateReplacePolicy: Retain
    Properties:
      VersioningConfiguration:
        Status: Enabled # Keeps history if you overwrite a file.
      CorsConfiguration:
        CorsRules:
          - AllowedOrigins: ['*'] # Allows your frontend to upload directly to S3.
            AllowedHeaders: ['*']
            AllowedMethods: [GET, PUT, HEAD]
            MaxAge: 300
      PublicAccessBlockConfiguration:
        # SECURITY: Maximum lockdown. No file is publicly viewable unless we explicitly sign a URL.
        BlockPublicAcls: true
        IgnorePublicAcls: true
        BlockPublicPolicy: true
        RestrictPublicBuckets: true

  # --- <a id="resource-dynamodb"></a>Databases (DynamoDB) ---

  # <a id="resource-tradestable"></a>
  TradesTable:
    Type: AWS::DynamoDB::Table
    Condition: CreateNewDataResources
    Properties:
      # Name includes Stage and ApiVersion. Changing ApiVersion creates a NEW table.
      TableName: !Sub Trades-${StageName}-${ApiVersion}
      
      BillingMode: PAY_PER_REQUEST 
      # ^ COST: You pay $0 if no one uses it. You pay per read/write. Good for startups.
      
      AttributeDefinitions: 
        # Defines the fields that will be used in Indexes.
        - AttributeName: userId
          AttributeType: S # String
        - AttributeName: tradeId
          AttributeType: S
        - AttributeName: openDate
          AttributeType: S
        - AttributeName: symbolOpenDate
          AttributeType: S
        - AttributeName: statusOpenDate
          AttributeType: S
        - AttributeName: idempotencyKey
          AttributeType: S
          
      KeySchema:
        # PRIMARY KEY: A combination of userId + tradeId.
        # This means every trade is unique to a user.
        - AttributeName: userId
          KeyType: HASH # Partition Key (Group data by User)
        - AttributeName: tradeId
          KeyType: RANGE # Sort Key (Find specific trade within User)
          
      GlobalSecondaryIndexes:
        # GSI: Allows you to search data in different ways.
        - IndexName: trades-by-date-gsi
          KeySchema:
            - AttributeName: userId
              KeyType: HASH
            - AttributeName: openDate # Search by User + Date
              KeyType: RANGE
          Projection:
            ProjectionType: ALL # Copy all data to this index.
        # ... (Other GSIs follow the same pattern for Symbol, Status, etc.)
        
      StreamSpecification:
        # EVENT ARCHITECTURE: This is crucial.
        # Every time data changes, send the "New" and "Old" version of the item
        # to a processing stream (used by UpdateStatsFunction).
        StreamViewType: NEW_AND_OLD_IMAGES

  # <a id="resource-tradestats"></a>
  TradeStatsTable:
    Type: AWS::DynamoDB::Table
    Condition: CreateNewDataResources
    Properties:
      TableName: !Sub TradeStats-${StageName}
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: userId
          AttributeType: S
      KeySchema:
        # Simple Key: Just userId. One stats row per user.
        - AttributeName: userId
          KeyType: HASH

  # <a id="resource-ratelimittable"></a>
  AuthRateLimitTable:
    Type: AWS::DynamoDB::Table
    Condition: CreateNewDataResources
    Properties:
      TableName: !Sub AuthRateLimit-${StageName}
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: key
          AttributeType: S
      KeySchema:
        - AttributeName: key
          KeyType: HASH
      TimeToLiveSpecification:
        AttributeName: ttl 
        Enabled: true
        # ^ FEATURE: DynamoDB will automatically delete rows when the 'ttl' timestamp passes.
        #   Used to "forget" that a user failed a login attempt after 15 minutes.

  # --- <a id="resource-httpapi"></a>API Gateway ---

  # <a id="resource-httpapi"></a>
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: !Ref StageName
      Auth:
        Authorizers:
          CognitoAuthorizer:
            # SECURITY: Checks the 'Authorization' header in requests.
            IdentitySource: "$request.header.Authorization"
            JwtConfiguration:
              # Verifies the token was issued by OUR User Pool.
              issuer: !Sub "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}"
              audience: [!Ref UserPoolClient]
        DefaultAuthorizer: CognitoAuthorizer # Apply this security to all routes by default.
      CorsConfiguration:
        AllowOrigins:
          - '*' # In production, change this to your specific domain (e.g., https://myapp.com)
        AllowMethods:
          - '*'
        AllowHeaders:
          - '*'
        ExposeHeaders:
          - Content-Type
          - Authorization
        MaxAge: 3600

  # --- <a id="resource-lambdas"></a>Lambda Functions (The Logic) ---
  
  # 1. Create Trade Function
  CreateTradeFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: . # The code is in the current directory
      Handler: src/handlers/create-trade/app.handler # The specific function to run inside the file.
      AutoPublishAlias: live
      DeploymentPreference:
        Type: Canary10Percent5Minutes
        # ^ DEVOPS: Safer Deployments. When you update this, send 10% traffic to new code.
        #   Wait 5 mins. If no errors, send 100%. If errors, rollback automatically.
      Policies:
        # PERMISSIONS: What is this function allowed to do?
        - DynamoDBCrudPolicy: # Read/Write to Trades Table
            TableName: !If [CreateNewDataResources, !Ref TradesTable, !Ref ExistingTradesTableName]
        - Statement:
            Effect: Allow
            Action:
              - s3:ListBucket
            Resource: !If [CreateNewDataResources, !GetAtt ImagesBucket.Arn, !Sub "arn:aws:s3:::${ExistingImagesBucketName}"]
        - Statement:
            Effect: Allow
            Action:
              - s3:PutObject # Upload files
            Resource: !If [CreateNewDataResources, !Sub "${ImagesBucket.Arn}/images/*", !Sub "arn:aws:s3:::${ExistingImagesBucketName}/images/*"]
      Events:
        Api:
          Type: HttpApi # Connect to the API Gateway created above
          Properties:
            ApiId: !Ref HttpApi
            Path: /v1/trades # The URL path
            Method: POST # The HTTP Verb

    Metadata:
      # BUILD SETTINGS: How 'sam build' prepares the code.
      BuildMethod: esbuild # Use esbuild (fast bundler)
      BuildProperties:
        EntryPoints:
          - src/handlers/create-trade/app.ts
        Minify: true # Make code small
        Target: es2020
        Sourcemap: true # Enable debugging

  # ... [Other CRUD functions (Get, List, Update, Delete) follow the exact same pattern] ...

  # 2. Update Stats Function (Event Driven)
  UpdateStatsFunction:
    Type: AWS::Serverless::Function
    Condition: CreateNewDataResources
    Properties:
      CodeUri: .
      Handler: src/handlers/update-stats/app.handler
      Policies:
        - DynamoDBReadPolicy: # Read Trades
            TableName: !If [CreateNewDataResources, !Ref TradesTable, !Ref ExistingTradesTableName]
        - DynamoDBCrudPolicy: # Write Stats
            TableName: !If [CreateNewDataResources, !Ref TradeStatsTable, !Ref ExistingTradeStatsTableName]
      DeadLetterQueue:
        Type: SQS
        TargetArn: !GetAtt StatsDLQ.Arn 
        # ^ ERROR HANDLING: If this function fails 2 times, send the data to a Queue so we can inspect it later.
      Events:
        Stream:
          Type: DynamoDB
          Properties:
            Stream: !GetAtt TradesTable.StreamArn # Triggers automatically when TradesTable changes.
            StartingPosition: LATEST
            BisectBatchOnFunctionError: true
            MaximumRetryAttempts: 2
            DestinationConfig:
              OnFailure:
                Destination: !GetAtt StatsDLQ.Arn

  # <a id="resource-statsdlq"></a>
  StatsDLQ:
    Type: AWS::SQS::Queue
    Condition: CreateNewDataResources
    Properties:
      QueueName: !Sub stats-dlq-${StageName}
      MessageRetentionPeriod: 1209600 # Keep failed messages for 14 days.

  # 3. AI Extraction Function
  ExtractTradesFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Handler: src/handlers/extract-trades/app.handler
      Timeout: 600 # Extended timeout (10 mins) because AI processing is slow.
      Policies:
        - Statement:
            Effect: Allow
            Action:
              - ssm:GetParameter # Permission to read the API Key from AWS Systems Manager
            Resource: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${GeminiApiKeyParamName}"
        - Statement:
            Effect: Allow
            Action:
              - kms:Decrypt # Permission to decrypt the secure key
            Resource: "*"
      Environment:
        Variables:
          GEMINI_API_KEY_PARAM: !Ref GeminiApiKeyParamName # Pass the param name to the code
      Events:
        Api:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /v1/trades/extract
            Method: POST

# -------------------------------------------------------------------------
# OUTPUTS
# Values displayed in the terminal after deployment finishes.
# Used to configure your Frontend Application.
# -------------------------------------------------------------------------
Outputs:
  ApiBaseUrl:
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/${StageName}/${ApiVersion}"
    # ^ The URL you put in your React/Vue app to make API calls.
  
  UserPoolId:
    Value: !Ref UserPool
    # ^ Needed for frontend login.
  
  UserPoolClientId:
    Value: !Ref UserPoolClient
    # ^ Needed for frontend login.
  
  TradesTableName:
    Value: !If [CreateNewDataResources, !Ref TradesTable, !Ref ExistingTradesTableName]
    # ^ Useful for debugging.
```