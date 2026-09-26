import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "../api/http-api";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { ServiceName } from "../observability/services";
import { IamPolicyStatement } from "../observability/observability-policy";

/**
 * The Verified Permissions grant every Cognito-authorized route Lambda needs: @boxalarm/authz
 * calls IsAuthorizedWithToken in-handler. Shared by every route component so the statement is
 * written once.
 */
export function verifiedPermissionsStatement(): IamPolicyStatement {
  return {
    Sid: "VerifiedPermissionsIsAuthorized",
    Effect: "Allow",
    Action: ["verifiedpermissions:IsAuthorizedWithToken"],
    Resource: "*",
  };
}

export interface AlertingRouteArgs {
  env: string;
  httpApi: HttpApi;
  logGroup: ServiceLogGroup;
  serviceName: ServiceName;
  functionName: string;
  handler: string;
  code: pulumi.Input<pulumi.asset.Archive>;
  routeKey: string;
  environment?: Record<string, pulumi.Input<string>>;
  additionalPolicyStatements?: pulumi.Input<IamPolicyStatement[]>;
  reservedConcurrentExecutions?: number;
  /** Seconds; unset means the AWS 3s default. API Gateway HTTP API caps integrations at 30s. */
  timeout?: number;
  permissionsBoundaryArn?: pulumi.Input<string>;
  /** false = no Cognito/Verified-Permissions authorizer (vendor webhook routes). Default true. */
  authorized?: boolean;
}

/**
 * One route Lambda + API Gateway integration + route, wired to the shared HttpApi.
 * Shared by every alerting/personnel/apparatus route in this batch so the
 * integration/permission/route boilerplate is written once (E1-S1/S4/S5/S6/S8/S9/S14/S18-INFRA).
 */
export class AlertingRoute extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly integration: aws.apigatewayv2.Integration;
  public readonly route: aws.apigatewayv2.Route;
  public readonly invokePermission: aws.lambda.Permission;

  constructor(name: string, args: AlertingRouteArgs, opts?: pulumi.ComponentResourceOptions) {
    super("boxalarm:alerting:AlertingRoute", name, {}, opts);

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env: args.env,
        serviceName: args.serviceName,
        functionName: args.functionName,
        handler: args.handler,
        code: args.code,
        logGroup: args.logGroup,
        environment: args.environment,
        additionalPolicyStatements: args.additionalPolicyStatements,
        reservedConcurrentExecutions: args.reservedConcurrentExecutions,
        timeout: args.timeout,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    this.integration = new aws.apigatewayv2.Integration(
      `${name}-integration`,
      {
        apiId: args.httpApi.httpApi.id,
        integrationType: "AWS_PROXY",
        integrationUri: this.lambda.function.invokeArn,
        payloadFormatVersion: "2.0",
      },
      { parent: this },
    );

    const target = pulumi.interpolate`integrations/${this.integration.id}`;

    this.route =
      args.authorized === false
        ? new aws.apigatewayv2.Route(
            `${name}-route`,
            { apiId: args.httpApi.httpApi.id, routeKey: args.routeKey, target },
            { parent: this },
          )
        : args.httpApi.authorizedRoute(
            `${name}-route`,
            { routeKey: args.routeKey, target },
            { parent: this },
          );

    this.invokePermission = new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.lambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${args.httpApi.httpApi.executionArn}/*/*`,
      },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda, route: this.route });
  }
}
