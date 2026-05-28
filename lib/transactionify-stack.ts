import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigwv2_authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { GoldenPathStack, GoldenPathStackProps } from "devex-framework";

/*
  Decisión arquitectónica: TransactionifyStack extiende GoldenPathStack
  en lugar de reemplazarlo.

  Esto implementa el principio de composición — el equipo de Transactionify
  hereda todas las convenciones del Golden Path (variables de entorno de
  contexto, outputs estándar, runtime correcto para Python) y agrega
  encima su infraestructura específica (DynamoDB, múltiples Lambdas,
  authorizer).

  Lo que aporta GoldenPathStack:
  - Tags estándar de DORA y auditoría
  - Variables de entorno SERVICE_NAME, ENVIRONMENT, LANGUAGE
  - CfnOutputs estandarizados
  - Runtime ARM64 por default

  Lo que agrega TransactionifyStack:
  - DynamoDB con single table pattern
  - HTTP API v2 con authorizer
  - Múltiples Lambdas con handlers específicos
*/
export class TransactionifyStack extends GoldenPathStack {
  constructor(scope: Construct, id: string, props: GoldenPathStackProps) {
    /*
      Llamamos al constructor del padre con la configuración de Transactionify.
      El handler y codePath del padre no se usan directamente porque
      Transactionify tiene múltiples Lambdas, pero los necesitamos
      para satisfacer el contrato de GoldenPathStackProps.
    */
    super(scope, id, {
      ...props,
      service: "transactionify",
      language: "python",
      environment: props.environment,
      codePath: "src/python",
      handler: "transactionify.handlers.api.rest.account.create.main.handler",
    });

    // Tags de finops heredados del Golden Path + específicos de Transactionify
    cdk.Tags.of(this).add("finops:Project", "Transactionify");
    cdk.Tags.of(this).add("finops:Service", "Transactionify API");
    cdk.Tags.of(this).add("finops:Team", "Platform");

    // DynamoDB — single table pattern
    const table = new dynamodb.Table(this, "DynamoDBTable", {
      tableName: `${cdk.Stack.of(this).stackName}-table`,
      partitionKey: {
        name: "PK",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "SK",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // HTTP API v2
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${cdk.Stack.of(this).stackName}-api`,
      createDefaultStage: true,
    });

    /*
      Función helper para crear Lambdas con convenciones estándar.

      Decisión: extraemos esto como función local para evitar repetición
      y garantizar que todas las Lambdas del stack tienen las mismas
      variables de entorno de contexto que el framework requiere para
      emitir eventos DORA.
    */
    const createLambda = (
      id: string,
      handler: string,
      description: string
    ): lambda.Function => {
      return new lambda.Function(this, id, {
        description,
        functionName: `${cdk.Stack.of(this).stackName}-${id.toLowerCase()}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler,
        code: lambda.Code.fromAsset("src/python"),
        architecture: lambda.Architecture.ARM_64,
        environment: {
          TABLE_NAME: table.tableName,
          // Variables de contexto del framework para DORA
          SERVICE_NAME: "transactionify",
          ENVIRONMENT: props.environment,
          LANGUAGE: "python",
        },
      });
    };

    // Authorizer Lambda
    const authorizerLambda = createLambda(
      "AuthorizerLambda",
      "transactionify.handlers.authorizer.main.handler",
      "API Key authorizer"
    );
    table.grantReadData(authorizerLambda);

    const authorizer = new apigwv2_authorizers.HttpLambdaAuthorizer(
      "LambdaAuthorizer",
      authorizerLambda,
      {
        identitySource: ["$request.header.Authorization"],
        resultsCacheTtl: cdk.Duration.minutes(0),
        responseTypes: [apigwv2_authorizers.HttpLambdaResponseType.SIMPLE],
      }
    );

    // Provisioning Lambda
    const provisioningLambda = createLambda(
      "ProvisioningLambda",
      "transactionify.handlers.provisioning.main.handler",
      "Registers a new user by generating a new API Key"
    );
    table.grantWriteData(provisioningLambda);

    // Create Account Lambda
    const createAccountLambda = createLambda(
      "CreateAccountLambda",
      "transactionify.handlers.api.rest.account.create.main.handler",
      "Creates a new account for the authenticated user"
    );
    table.grantReadWriteData(createAccountLambda);

    // Create Payment Lambda
    const createPaymentLambda = createLambda(
      "CreatePaymentLambda",
      "transactionify.handlers.api.rest.payment.create.main.handler",
      "Creates a new payment for an account"
    );
    table.grantReadWriteData(createPaymentLambda);

    // Get Balance Lambda
    const getBalanceLambda = createLambda(
      "GetBalanceLambda",
      "transactionify.handlers.api.rest.balance.get.main.handler",
      "Gets the balance for an account"
    );
    table.grantReadData(getBalanceLambda);

    // List Transactions Lambda
    const listTransactionsLambda = createLambda(
      "ListTransactionsLambda",
      "transactionify.handlers.api.rest.transaction.list.main.handler",
      "Lists all transactions for an account"
    );
    table.grantReadData(listTransactionsLambda);

    // Rutas del API
    const addRoute = (
      path: string,
      method: apigwv2.HttpMethod,
      fn: lambda.Function,
      integrationId: string
    ) => {
      httpApi.addRoutes({
        path,
        methods: [method],
        integration: new apigwv2_integrations.HttpLambdaIntegration(
          integrationId,
          fn
        ),
        authorizer,
      });
    };

    addRoute("/api/v1/accounts", apigwv2.HttpMethod.POST, createAccountLambda, "CreateAccountIntegration");
    addRoute("/api/v1/accounts/{account_id}/payments", apigwv2.HttpMethod.POST, createPaymentLambda, "CreatePaymentIntegration");
    addRoute("/api/v1/accounts/{account_id}/balance", apigwv2.HttpMethod.GET, getBalanceLambda, "GetBalanceIntegration");
    addRoute("/api/v1/accounts/{account_id}/transactions", apigwv2.HttpMethod.GET, listTransactionsLambda, "ListTransactionsIntegration");

    // Outputs adicionales específicos de Transactionify
    new cdk.CfnOutput(this, "TableName", {
      value: table.tableName,
      description: "DynamoDB table name",
      exportName: `${cdk.Stack.of(this).stackName}-table-name`,
    });
  }
}