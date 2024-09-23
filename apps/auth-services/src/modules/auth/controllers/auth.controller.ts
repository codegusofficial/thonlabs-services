import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Headers,
  UnauthorizedException,
  Get,
  Patch,
  Query,
  Res,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { SchemaValidator } from '@/auth/modules/shared/decorators/schema-validator.decorator';
import { PublicRoute } from '@/auth/modules/auth/decorators/auth.decorator';
import { signUpValidator } from '@/auth/modules/auth/validators/signup-validators';
import { UserService } from '@/auth/modules/users/services/user.service';
import { ProjectService } from '@/auth/modules/projects/services/project.service';
import { EnvironmentService } from '@/auth/modules/environments/services/environment.service';
import {
  ErrorMessages,
  StatusCodes,
  exceptionsMapper,
} from '@/utils/enums/errors-metadata';
import {
  authenticateFromMagicLinkValidator,
  loginValidator,
  reauthenticateFromRefreshTokenValidator,
} from '../validators/login-validators';
import { AuthService } from '@/auth/modules/auth/services/auth.service';
import { EmailService } from '@/auth/modules/emails/services/email.service';
import { TokenStorageService } from '@/auth/modules/token-storage/services/token-storage.service';
import {
  AuthProviders,
  EmailTemplates,
  Environment,
  TokenTypes,
} from '@prisma/client';
import { NeedsPublicKey } from '@/auth/modules/shared/decorators/needs-public-key.decorator';
import decodeSession from '@/utils/services/decode-session';
import {
  newPasswordValidator,
  requestResetPasswordValidator,
} from '../validators/reset-password-validators';
import { getFirstName } from '@/utils/services/names-helpers';
import { HasEnvAccess } from '../../shared/decorators/has-env-access.decorator';
import { add } from 'date-fns';
import { PublicKeyOrThonLabsOnly } from '../../shared/decorators/public-key-or-thon-labs-user.decorator';
import { EnvironmentDataService } from '@/auth/modules/environments/services/environment-data.service';

@Controller('auth')
export class AuthController {
  private logger = new Logger(AuthController.name);

  constructor(
    private userService: UserService,
    private projectService: ProjectService,
    private environmentService: EnvironmentService,
    private environmentDataService: EnvironmentDataService,
    private authService: AuthService,
    private emailService: EmailService,
    private tokenStorageService: TokenStorageService,
  ) {}

  @Post('/signup/owner')
  @PublicRoute()
  public async signUpOwner(
    @Body() payload: { password: string; environmentId: string },
    @Headers() headers,
  ) {
    if (
      headers['thon-labs-staff-api-key'] !== process.env.TL_INTERNAL_API_KEY
    ) {
      throw new UnauthorizedException();
    }

    const { data: user } = await this.userService.createOwner({
      password: payload.password,
    });

    const {
      data: { project, environment },
    } = await this.projectService.create({
      appName: 'ThonLabs',
      userId: user.id,
      appURL: 'https://thonlabs.io',
      main: true,
    });

    const [, , publicKey] = await Promise.all([
      this.userService.setEnvironment(user.id, environment.id),
      this.environmentService.updateAuthSettings(environment.id, {
        ...environment,
        authProvider: AuthProviders.EmailAndPassword,
        enableSignUp: true,
      }),
      await this.environmentService.getPublicKey(environment.id),
    ]);

    return { user, project, ...{ ...environment, publicKey } };
  }

  @PublicRoute()
  @Post('/signup')
  @NeedsPublicKey()
  @SchemaValidator(signUpValidator)
  public async signUp(@Body() payload, @Req() req) {
    const { data: environment } =
      await this.environmentService.getByPublicKeyFromRequest(req);

    if (!environment) {
      throw new UnauthorizedException(ErrorMessages.Unauthorized);
    }

    const { data: enableSignUp } = await this.environmentDataService.get(
      environment.id,
      'enableSignUp',
    );

    if (!enableSignUp) {
      throw new exceptionsMapper[StatusCodes.Forbidden](
        ErrorMessages.Forbidden,
      );
    }

    const { data: user, ...userError } = await this.userService.create({
      ...payload,
      environmentId: environment.id,
    });

    if (userError.error) {
      throw new exceptionsMapper[userError.statusCode](userError.error);
    }

    const {
      data: { token },
      ...tokenError
    } = await this.tokenStorageService.create({
      relationId: user.id,
      type: payload.password ? TokenTypes.ConfirmEmail : TokenTypes.MagicLogin,
      expiresIn: payload.password ? '5h' : '30m',
      environmentId: environment.id,
    });

    if (tokenError.error) {
      throw new exceptionsMapper[tokenError.statusCode](tokenError.error);
    }

    const emailData = {
      token,
      userFirstName: getFirstName(user.fullName),
    };

    if (payload.password) {
      const { data: tokens } = await this.tokenStorageService.createAuthTokens(
        user,
        environment as Environment,
      );

      await Promise.all([
        this.emailService.send({
          userId: user.id,
          to: user.email,
          emailTemplateType: EmailTemplates.ConfirmEmail,
          environmentId: environment.id,
          data: emailData,
        }),
        this.emailService.send({
          userId: user.id,
          to: user.email,
          emailTemplateType: EmailTemplates.Welcome,
          environmentId: environment.id,
          scheduledAt: add(new Date(), { minutes: 5 }),
        }),
      ]);

      return tokens;
    } else {
      await Promise.all([
        this.emailService.send({
          userId: user.id,
          to: user.email,
          emailTemplateType: EmailTemplates.MagicLink,
          environmentId: environment.id,
          data: emailData,
        }),
        this.emailService.send({
          userId: user.id,
          to: user.email,
          emailTemplateType: EmailTemplates.Welcome,
          environmentId: environment.id,
          scheduledAt: add(new Date(), { minutes: 5 }),
        }),
      ]);
    }
  }

  @Post('/login')
  @PublicRoute()
  @HttpCode(StatusCodes.OK)
  @NeedsPublicKey()
  @SchemaValidator(loginValidator)
  async login(
    @Body() payload: { email: string; password?: string },
    @Req() req,
  ) {
    const { data: environment, ...envError } =
      await this.environmentService.getByPublicKeyFromRequest(req);

    if (envError.statusCode === StatusCodes.Unauthorized) {
      throw new UnauthorizedException(envError.error);
    }

    if (
      environment.authProvider === AuthProviders.EmailAndPassword &&
      payload.password
    ) {
      const result = await this.authService.authenticateFromEmailAndPassword(
        payload.email,
        payload.password,
        environment.id,
      );

      if (result?.error) {
        throw new exceptionsMapper[result.statusCode](result.error);
      }

      return result.data;
    } else if (environment.authProvider === AuthProviders.MagicLogin) {
      const result = await this.authService.sendMagicLink({
        email: payload.email,
        environment,
      });

      if (result?.error) {
        throw new exceptionsMapper[result.statusCode](result.error);
      }

      return {
        emailSent: true,
      };
    } else {
      throw new exceptionsMapper[StatusCodes.Unauthorized](
        ErrorMessages.InvalidCredentials,
      );
    }
  }

  @PublicRoute()
  @NeedsPublicKey()
  @Get('/magic/:token')
  @SchemaValidator(authenticateFromMagicLinkValidator, ['params'])
  public async authenticateFromMagicLink(@Param('token') token: string) {
    const data = await this.authService.authenticateFromMagicLink({
      token,
    });

    if (data?.error) {
      throw new exceptionsMapper[data.statusCode](data.error);
    }

    return data?.data;
  }

  @PublicRoute()
  @Post('/refresh')
  @HasEnvAccess({ param: 'tl-env-id', source: 'headers' })
  @SchemaValidator(reauthenticateFromRefreshTokenValidator)
  public async reAuthenticateFromRefreshToken(
    @Body('token') token: string,
    @Req() req,
  ) {
    const environmentId = req.headers['tl-env-id'];

    const { data: environment, ...envError } =
      await this.environmentService.getById(environmentId);

    if (envError?.error) {
      throw new exceptionsMapper[envError.statusCode](envError.error);
    }

    if (!environment.refreshTokenExpiration) {
      throw new exceptionsMapper[StatusCodes.Unauthorized]();
    }

    const data = await this.authService.reAuthenticateFromRefreshToken({
      token,
      environmentId: environment.id,
    });

    if (data?.error) {
      throw new exceptionsMapper[data.statusCode](data.error);
    }

    return data;
  }

  @Post('/logout')
  @HttpCode(StatusCodes.OK)
  @PublicKeyOrThonLabsOnly()
  @HasEnvAccess({ param: 'tl-env-id', source: 'headers' })
  public async logout(@Req() req) {
    const { sub: userId } = decodeSession(req);
    const environmentId = req.headers['tl-env-id'];

    const { data: environment, ...envError } =
      await this.environmentService.getById(environmentId);

    if (envError?.error) {
      throw new exceptionsMapper[envError.statusCode](envError.error);
    }

    const data = await this.authService.logout({
      userId,
      environmentId: environment.id,
    });

    return data;
  }

  @PublicRoute()
  @NeedsPublicKey()
  @Post('/reset-password')
  @SchemaValidator(requestResetPasswordValidator)
  public async requestResetPassword(@Req() req, @Body() payload) {
    const { data: environment } =
      await this.environmentService.getByPublicKeyFromRequest(req);

    if (!environment) {
      throw new UnauthorizedException(ErrorMessages.Unauthorized);
    }

    const user = await this.userService.getByEmail(
      payload.email,
      environment.id,
    );

    if (user && user.active) {
      await this.tokenStorageService.deleteMany(
        TokenTypes.ResetPassword,
        user.id,
      );

      const token = await this.tokenStorageService.create({
        expiresIn: '30m',
        relationId: user.id,
        type: TokenTypes.ResetPassword,
        environmentId: environment.id,
      });

      if (token.error) {
        throw new exceptionsMapper[token.statusCode](token.error);
      }

      await this.emailService.send({
        emailTemplateType: EmailTemplates.ForgotPassword,
        environmentId: environment.id,
        userId: user.id,
        to: user.email,
        data: {
          token: token.data.token,
        },
      });
    }
  }

  @PublicRoute()
  @NeedsPublicKey()
  @HttpCode(StatusCodes.OK)
  @Get('/reset-password/:token')
  public async validateTokenResetPassword(@Param('token') token: string) {
    const tokenValidation = await this.authService.validateUserTokenExpiration(
      token,
      TokenTypes.ResetPassword,
    );

    if (tokenValidation.statusCode) {
      throw new exceptionsMapper[tokenValidation.statusCode](
        tokenValidation.error,
      );
    }

    const isActiveUser = await this.userService.isActiveUser(
      tokenValidation.data.relationId,
      tokenValidation.data.environmentId,
    );

    if (!isActiveUser) {
      throw new exceptionsMapper[StatusCodes.NotAcceptable](
        ErrorMessages.InvalidUser,
      );
    }
  }

  @PublicRoute()
  @HttpCode(StatusCodes.OK)
  @NeedsPublicKey()
  @Patch('/reset-password/:token')
  @SchemaValidator(newPasswordValidator)
  public async updateTokenResetPassword(
    @Req() req,
    @Param('token') token: string,
    @Body() payload,
  ) {
    const { data: environment } =
      await this.environmentService.getByPublicKeyFromRequest(req);

    if (!environment) {
      throw new UnauthorizedException(ErrorMessages.Unauthorized);
    }

    const tokenValidation = await this.authService.validateUserTokenExpiration(
      token,
      TokenTypes.ResetPassword,
    );

    if (tokenValidation?.statusCode) {
      throw new exceptionsMapper[tokenValidation.statusCode](
        tokenValidation.error,
      );
    }

    const [, updatePassword] = await Promise.all([
      this.tokenStorageService.delete(token),
      this.userService.updatePassword(
        tokenValidation.data.relationId,
        environment.id,
        payload.password,
      ),
    ]);

    if (updatePassword?.statusCode) {
      throw new exceptionsMapper[updatePassword.statusCode](
        updatePassword.error,
      );
    }
  }

  @PublicRoute()
  @NeedsPublicKey()
  @HttpCode(StatusCodes.OK)
  @Get('/confirm-email/:token')
  public async confirmEmail(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    let tokenValidation = await this.authService.validateUserTokenExpiration(
      token,
      TokenTypes.ConfirmEmail,
    );

    if (tokenValidation?.statusCode === StatusCodes.NotFound) {
      tokenValidation = await this.authService.validateUserTokenExpiration(
        token,
        TokenTypes.InviteUser,
      );
    }

    // If not found both types of token, then returns 404
    if (tokenValidation?.statusCode) {
      if (
        tokenValidation?.data?.type === TokenTypes.ConfirmEmail &&
        tokenValidation?.data?.relationId
      ) {
        /*
          If token is expired but has relationId, then resend the confirmation email
          the request is not valid, but it's like a retry to make sure the user will
          validate his email.
        */
        const emailSent = await this.userService.sendConfirmationEmail(
          tokenValidation.data.relationId,
          tokenValidation.data.environmentId,
        );

        await this.tokenStorageService.delete(token);

        if (emailSent.data) {
          throw new exceptionsMapper[StatusCodes.NotAcceptable]({
            statusCode: StatusCodes.NotAcceptable,
            emailResent: true,
          });
        }
      }

      throw new exceptionsMapper[tokenValidation.statusCode](
        tokenValidation.error,
      );
    }

    const userId = tokenValidation.data.relationId;
    const environmentId = tokenValidation.data.environmentId;

    const updateEmailConfirmation =
      await this.userService.updateEmailConfirmation(userId, environmentId);

    await this.tokenStorageService.delete(token);

    if (updateEmailConfirmation?.statusCode) {
      throw new exceptionsMapper[updateEmailConfirmation.statusCode](
        updateEmailConfirmation.error,
      );
    }

    /*
      In case of invitation, after confirm the email the user
      needs to set a password or login using magic link.
    */
    const user = await this.userService.getById(userId);
    const { data: environment } =
      await this.environmentService.getById(environmentId);

    if (
      tokenValidation.data.type === TokenTypes.InviteUser &&
      !user.lastSignIn
    ) {
      if (environment.authProvider === AuthProviders.EmailAndPassword) {
        const resetPasswordToken =
          await this.authService.generateResetPasswordToken(
            user.id,
            environmentId,
          );

        if (resetPasswordToken?.statusCode) {
          throw new exceptionsMapper[resetPasswordToken.statusCode](
            resetPasswordToken.error,
          );
        }

        return res.status(StatusCodes.OK).json({
          tokenType: TokenTypes.ResetPassword,
          token: resetPasswordToken?.data?.token,
          email: user.email,
        });
      } else if (environment.authProvider === AuthProviders.MagicLogin) {
        const magicLoginToken = await this.authService.generateMagicLoginToken(
          user.id,
          environmentId,
        );

        if (magicLoginToken?.statusCode) {
          throw new exceptionsMapper[magicLoginToken.statusCode](
            magicLoginToken.error,
          );
        }

        return res.status(StatusCodes.OK).json({
          tokenType: TokenTypes.MagicLogin,
          token: magicLoginToken?.data?.token,
        });
      }

      this.logger.error(
        'Error on generating reset password or magic login token.',
      );
      throw new exceptionsMapper[StatusCodes.Internal](
        ErrorMessages.InternalError,
      );
    }

    return res.status(StatusCodes.OK).json({});
  }
}
