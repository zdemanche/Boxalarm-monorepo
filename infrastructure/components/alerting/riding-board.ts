import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";

export interface RidingBoardArgs {
  env: string;
  httpApi: HttpApi;
  platformTableArn: pulumi.Input<string>;
  platformTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  policyStoreId: pulumi.Input<string>;
}

/**
 * Live riding board (E1-S18-INFRA, partial). The merged backend
 * (src/services/apparatus-service/ridingBoard/handler.ts) reads/writes the
 * platform-service table via apparatus-service's own client, not the alerting table as
 * the ticket's Scope assumed — architecture has no riding-board design yet (ticket's own
 * Current state) and the ticket predates this implementation. Wired here as apparatus
 * routes against the platform table; the apparatus-status-changed copy into alerting and
 * the board-assignment bridge event depend on infra from other batches (E4 apparatus
 * infra) not present on this branch, so those two pieces are deferred, not built.
 */
export class RidingBoard extends pulumi.ComponentResource {
  public readonly getRoute: AlertingRoute;
  public readonly assignRoute: AlertingRoute;

  constructor(name: string, args: RidingBoardArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RidingBoard", args.env);
    super("boxalarm:alerting:RidingBoard", name, {}, opts);
    const { env } = args;

    const environment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };
    // Cast like the table ARN below: ServiceLambda deep-resolves nested Outputs.
    const apparatusIndexArn =
      pulumi.interpolate`${args.platformTableArn}/index/GSI3` as unknown as string;
    const vpStatement = verifiedPermissionsStatement();

    // src/services/apparatus-service/ridingBoard/handler.getRidingBoardHandler
    this.getRoute = new AlertingRoute(
      `${name}-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-riding-board-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "riding-board-get"),
        routeKey: "GET /api/v1/apparatus/riding-board/{dispatchId}",
        environment,
        additionalPolicyStatements: [
          {
            Sid: "PlatformTableReadOnly",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Resource: args.platformTableArn as string,
          },
          {
            // listApparatusForBoard queries IndexName 'GSI3' (ridingBoard/repository.ts);
            // a table-ARN grant does not cover an index.
            Sid: "PlatformTableApparatusIndexQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: apparatusIndexArn,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    // src/services/apparatus-service/ridingBoard/handler.assignRidingPositionHandler
    this.assignRoute = new AlertingRoute(
      `${name}-assign`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-riding-board-assign`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "riding-board-assign"),
        routeKey: "POST /api/v1/apparatus/riding-board/{dispatchId}/assignments",
        environment,
        additionalPolicyStatements: [
          {
            // assignSeat's single TransactWriteCommand holds a ConditionCheck (apparatus
            // IN_SERVICE), an Update (the seat), and two Puts (history + outbox). DynamoDB
            // authorizes each transaction item as its own action, so all three item
            // actions are required; TransactWriteItems is kept alongside for clarity.
            Sid: "PlatformTableReadWrite",
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:ConditionCheckItem",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
              "dynamodb:TransactWriteItems",
            ],
            Resource: args.platformTableArn as string,
          },
          {
            // findApparatusItem (apparatus-service/repository.ts) queries IndexName 'GSI3'.
            Sid: "PlatformTableApparatusIndexQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: apparatusIndexArn,
          },
          vpStatement,
        ],
        reservedConcurrentExecutions: 5,
      },
      { parent: this },
    );

    this.registerOutputs({ getRoute: this.getRoute, assignRoute: this.assignRoute });
  }
}
