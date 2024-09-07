import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EmailTemplate, EmailTemplates } from '@prisma/client';
import { render } from '@react-email/render';
import emailTemplatesMapper from '../mappers/email-templates-mapper';
import { DataReturn } from '@/utils/interfaces/data-return';
import { ErrorMessages, StatusCodes } from '@/utils/enums/errors-metadata';
import { unescape } from 'lodash';
import { EnvironmentService } from '@/auth/modules/environments/services/environment.service';
import { getRootDomain } from '@/utils/services/domain';

@Injectable()
export class EmailTemplateService {
  private readonly logger = new Logger(EmailTemplateService.name);

  constructor(
    private databaseService: DatabaseService,
    @Inject(forwardRef(() => EnvironmentService))
    private environmentService: EnvironmentService,
  ) {}

  async getByType(type: EmailTemplates, environmentId: string) {
    const emailTemplate = await this.databaseService.emailTemplate.findFirst({
      where: {
        type,
        environmentId,
      },
    });

    return emailTemplate;
  }

  async createDefaultTemplates(environmentId: string): Promise<DataReturn> {
    try {
      await this.databaseService.emailTemplate.deleteMany({
        where: { environmentId },
      });
      this.logger.log(`Deleted all templates for env: ${environmentId}`);

      const environment =
        await this.environmentService.getDetailedById(environmentId);

      const emailDomain = getRootDomain(new URL(environment.appURL).hostname);

      for (const [type, data] of Object.entries(emailTemplatesMapper)) {
        const content = unescape(render(data.content, { pretty: true }));

        await this.databaseService.emailTemplate.create({
          data: {
            type: type as EmailTemplates,
            content,
            name: data.name,
            subject: data.subject,
            fromEmail: `${data.fromEmail}@${emailDomain}`,
            fromName: `${environment.project.appName} Team`,
            preview: data.preview,
            replyTo: data.replyTo,
            environmentId,
          },
        });

        this.logger.log(`Email template ${type} created`);
      }

      this.logger.log(`Email templates created for env: ${environmentId}`);
    } catch (e) {
      this.logger.log('Error on creating email templates', e);
      return {
        error: ErrorMessages.InternalError,
        statusCode: StatusCodes.Internal,
      };
    }
  }

  async updateTemplate(
    id: string,
    environmentId: string,
    payload: {
      name: string;
      subject: string;
      fromName: string;
      fromEmail: string;
      content: string;
      preview: string;
      replyTo: string;
    },
  ): Promise<DataReturn<EmailTemplate>> {
    console.log(unescape(payload.content));

    return;

    const emailTemplateCount = await this.databaseService.emailTemplate.count({
      where: {
        id,
      },
    });

    if (emailTemplateCount === 0) {
      this.logger.error(`Email template ${id} not found`);
      return {
        statusCode: StatusCodes.NotFound,
        error: ErrorMessages.EmailTemplateNotFound,
      };
    }

    const emailTemplate = await this.databaseService.emailTemplate.update({
      where: {
        id,
        environmentId,
      },
      data: {
        name: payload.name,
        subject: payload.subject,
        fromName: payload.fromName,
        fromEmail: payload.fromEmail,
        content: unescape(payload.content),
        preview: payload.preview,
        replyTo: payload.replyTo,
      },
    });

    this.logger.log(`Email template ${id} updated`);

    return {
      data: emailTemplate,
    };
  }
}
