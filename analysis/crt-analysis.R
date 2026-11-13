# Usage: Rscript analysis/crt-analysis.R participants.csv cases.csv output-directory
# Base R for the preregistered participant-level model; lme4 is optional for exploration.
args <- commandArgs(trailingOnly=TRUE)
if(length(args)!=3) stop('participants.csv cases.csv output-directory 인수가 필요합니다.')
p <- read.csv(args[1], na.strings=c('','NA'), check.names=FALSE)
cases <- read.csv(args[2], na.strings=c('','NA'), check.names=FALSE)
out <- args[3]; dir.create(out, recursive=TRUE, showWarnings=FALSE)
if(anyDuplicated(p$run_id)) stop('참가자 실행 중복을 먼저 해결하세요.')
# Keep the full imported roster before applying the primary-analysis filter.
roster <- p
flow <- aggregate(list(n=rep(1,nrow(roster))), by=roster[c('mode','condition','status','primary_ready')], FUN=sum)
write.csv(flow,file.path(out,'participant-flow.csv'),row.names=FALSE)
if('exclusion_reasons' %in% names(roster)) {
 reasons <- do.call(rbind,lapply(seq_len(nrow(roster)),function(i){
  reason <- strsplit(ifelse(is.na(roster$exclusion_reasons[i]),'',roster$exclusion_reasons[i]),';',fixed=TRUE)[[1]]
  if(!length(reason))return(NULL)
  data.frame(mode=roster$mode[i],condition=roster$condition[i],reason=reason,n=1)
 }))
 if(!is.null(reasons))write.csv(aggregate(n~mode+condition+reason,data=reasons,FUN=sum),file.path(out,'exclusion-reasons.csv'),row.names=FALSE)
}
balance <- do.call(rbind,lapply(c('ai_frequency','exposure'),function(field){
 if(!field %in% names(roster)) return(NULL)
 d <- roster[roster$mode=='study',,drop=FALSE]
 if(!nrow(d)) return(NULL)
 d[[field]][is.na(d[[field]])] <- 'missing'
 z <- aggregate(list(n=rep(1,nrow(d))),by=list(condition=d$condition,value=d[[field]]),FUN=sum)
 z$variable <- field;z
}))
if(!is.null(balance))write.csv(balance,file.path(out,'allocation-balance.csv'),row.names=FALSE)
p <- p[p$mode=='study'  & p$primary_ready==1, , drop=FALSE]
if(nrow(p)==0) stop('분석 가능한 본 실험 자료가 없습니다. 파일럿은 별도 분석하세요.')
if(length(unique(p$study_version))!=1 || unique(p$study_version)!='4.0.0') stop('연구 버전 혼합')
write.csv(data.frame(metric=c('eligible_complete_n','pilot_excluded','inferential_policy'),value=c(nrow(p),'yes',if(nrow(p)>=24)'estimates_CI_p' else if(nrow(p)>=12)'estimates_CI_only' else 'descriptive_only')),file.path(out,'reporting-policy.csv'),row.names=FALSE)
# Report each required outcome separately, retaining the signed and absolute errors.
metrics <- c('mean_d_apply','mean_d_explain','mean_pred_apply','mean_actual_apply','mean_pred_explain','mean_actual_explain','mean_absolute_error_apply','mean_confidence','mean_burden','d_baseline','se_baseline')
summary <- do.call(rbind,lapply(split(p,p$condition),function(d) do.call(rbind,lapply(metrics,function(m)data.frame(condition=d$condition[1],metric=m,n=sum(!is.na(d[[m]])),mean=mean(d[[m]],na.rm=TRUE),sd=sd(d[[m]],na.rm=TRUE))))))
write.csv(summary,file.path(out,'descriptives.csv'),row.names=FALSE)
write.csv(p,file.path(out,'analysis-participants.csv'),row.names=FALSE)
pdf(file.path(out,'participant-calibration.pdf'),width=9,height=5)
plot(p$mean_actual_apply,p$mean_pred_apply,xlim=c(0,6),ylim=c(0,6),xlab='Actual application (0-6)',ylab='Predicted application (0-6)',pch=19,col=as.integer(factor(p$condition)))
abline(0,1,lty=2);legend('topleft',legend=levels(factor(p$condition)),col=seq_along(unique(p$condition)),pch=19)
plot(seq_len(nrow(p)),p$mean_d_apply,pch=19,col=as.integer(factor(p$condition)),xlab='Participant',ylab='Mean signed application error',ylim=c(-6,6));abline(h=0,lty=2)
dev.off()
dist<-do.call(rbind,lapply(split(p,p$condition),function(d){z<-factor(sign(d$mean_d_apply),levels=c(-1,0,1));data.frame(condition=d$condition[1],direction=c('under','equal','over'),count=as.integer(table(z)),proportion=as.numeric(prop.table(table(z))))}))
write.csv(dist,file.path(out,'signed-error-distribution.csv'),row.names=FALSE)
pdf(file.path(out,'signed-error-distribution.pdf'),width=7,height=5)
barplot(xtabs(proportion~direction+condition,data=dist),beside=FALSE,ylim=c(0,1),ylab='Participant proportion',legend.text=TRUE)
dev.off()
c <- cases[cases$run_id %in% p$run_id & cases$task_id!='practice',,drop=FALSE]
if(all(c('no_trap_numeric_correct','retention_numeric_correct','retention_work_present') %in% names(c))){
 numeric <- do.call(rbind,lapply(split(c,c$condition),function(d){
  correct <- d$retention_numeric_correct==1
  data.frame(condition=d$condition[1],no_trap_n=nrow(d),no_trap_resolved=sum(!is.na(d$no_trap_numeric_correct)),no_trap_unresolved=sum(is.na(d$no_trap_numeric_correct)),no_trap_numeric_error_rate=mean(1-d$no_trap_numeric_correct,na.rm=TRUE),retention_numeric_correct_n=sum(correct,na.rm=TRUE),retention_numeric_unresolved=sum(is.na(d$retention_numeric_correct)),retention_correct_without_work_n=sum(correct & d$retention_work_present==0,na.rm=TRUE),retention_correct_without_work_proportion=if(sum(correct,na.rm=TRUE))sum(correct & d$retention_work_present==0,na.rm=TRUE)/sum(correct,na.rm=TRUE) else NA_real_)
 }))
 write.csv(numeric,file.path(out,'advisory-numeric-outcomes.csv'),row.names=FALSE)
}

if(nrow(p)<12){message('12명 미만: 기술통계만 산출했습니다.');quit(status=0)}
report_p <- nrow(p)>=24
# Prespecified sample-size policy is applied to all inferential reports, not only the primary test.
hc3 <- function(formula,data,label){
 model <- lm(formula,data=data); X<-model.matrix(model); if(qr(X)$rank<ncol(X)||df.residual(model)<1) stop(paste(label,'추정 불가: 표본·모형 계수 확인'))
 inv<-solve(crossprod(X)); h<-hatvalues(model); if(any(h>=1-1e-10)) stop(paste(label,'HC3 추정 불가'))
 V<-inv %*% crossprod(X,X*as.numeric((residuals(model)/(1-h))^2)) %*% inv
 se<-sqrt(diag(V)); est<-coef(model); critical<-qt(.975,df.residual(model));pv<-2*pt(-abs(est/se),df.residual(model))
 rows<-data.frame(analysis=label,term=names(est),estimate=est,se_hc3=se,ci_low=est-critical*se,ci_high=est+critical*se,p=if(report_p)pv else NA_real_,n=nobs(model))
 list(rows=rows,model=model)
}
results<-list(); notes<-character()
safe <- function(label,fn){tryCatch(fn(),error=function(e){notes<<-c(notes,paste(label,conditionMessage(e),sep=': '));NULL})}
if(all(p$condition=='within')){
 d<-p$within_ai_d-p$within_control_d;z<-safe('within',function()t.test(d));if(!is.null(z))write.csv(data.frame(estimate=mean(d),ci_low=z$conf.int[1],ci_high=z$conf.int[2],p=if(report_p)z$p.value else NA,n=length(d)),file.path(out,'within-paired.csv'),row.names=FALSE)
 notes<-c(notes,'집단 내 대안: AI가 항상 뒤에 있어 위치·연습·피로와 AI 효과가 섞입니다.')
}else{
 if(!all(p$condition %in% c('control','assisted')))stop('집단 간·집단 내 설계 자료를 섞지 마세요.')
 p$group<-as.integer(p$condition=='assisted')
 runmodel<-function(formula,data,label){r<-safe(label,function()hc3(formula,data,label));if(!is.null(r))results[[length(results)+1]]<<-r$rows;return(r)}
 primary<-runmodel(mean_d_apply~group+d_baseline,p,'primary_HC3')
 runmodel(mean_d_explain~group+d_baseline,p,'explanation_HC3')
 runmodel(first_d_apply~group+d_baseline,p,'first_bundle_HC3')
 runmodel(mean_d_apply~group+d_baseline+factor(latin_order),p,'order_adjusted_HC3')
 runmodel(mean_d_apply~group+d_baseline,p[p$exposure!='yes',,drop=FALSE],'exclude_prior_exposure_HC3')
 runmodel(mean_d_apply~group+d_baseline,p[p$delivery!='remote',,drop=FALSE],'exclude_remote_HC3')
 runmodel(mean_confidence~group+se_baseline,p,'self_efficacy_HC3')
 welch<-safe('Welch',function()t.test(p$mean_d_apply[p$group==1],p$mean_d_apply[p$group==0]))
 if(!is.null(welch))write.csv(data.frame(contrast='assisted-control',estimate=diff(rev(welch$estimate)),ci_low=welch$conf.int[1],ci_high=welch$conf.int[2],p=if(report_p)welch$p.value else NA_real_),file.path(out,'welch.csv'),row.names=FALSE)
 if(!is.null(primary)){
 adjusted<-predict(primary$model,newdata=data.frame(group=0:1,d_baseline=mean(p$d_baseline)))
 write.csv(data.frame(condition=c('control','assisted'),adjusted_d_apply=adjusted),file.path(out,'adjusted-means.csv'),row.names=FALSE)
 g<-split(p$mean_d_apply,p$group);pooled<-sqrt(sum(vapply(g,function(v)(length(v)-1)*var(v),numeric(1)))/(nrow(p)-2))
 effect<-primary$rows[primary$rows$term=='group',,drop=FALSE]
 write.csv(data.frame(definition='adjusted difference divided by raw pooled SD',d=effect$estimate/pooled,ci_low=effect$ci_low/pooled,ci_high=effect$ci_high/pooled),file.path(out,'standardized-effect.csv'),row.names=FALSE)
 }
 corrs<-do.call(rbind,lapply(split(p,p$condition),function(d)data.frame(condition=d$condition[1],n=nrow(d),confidence_performance_r=if(nrow(d)>2)cor(d$mean_confidence,d$mean_actual_apply) else NA_real_)))
 write.csv(corrs,file.path(out,'confidence-performance-correlation.csv'),row.names=FALSE)
 c<-cases[cases$run_id %in% p$run_id & cases$task_id!='practice',,drop=FALSE]
 write.csv(aggregate(c[c('apply_a','apply_b','apply_c','initial_correct','trap_selected','burden_7')],by=c[c('condition','position')],FUN=function(x)mean(x,na.rm=TRUE)),file.path(out,'application-types-by-position.csv'),row.names=FALSE)
 c$group<-as.integer(c$condition=='assisted');c$d_baseline<-p$d_baseline[match(c$run_id,p$run_id)]
 if(requireNamespace('lme4',quietly=TRUE)){
  mixed<-safe('position mixed model',function()lme4::lmer(d_apply~group*position+factor(task_id)+d_baseline+(1|run_id),data=c,REML=FALSE))
  if(!is.null(mixed))capture.output(summary(mixed),file=file.path(out,'position-mixed-model.txt'))
 }else notes<-c(notes,'lme4가 없어 탐색적 위치 혼합모형은 실행하지 않았습니다. 설치 후 다시 실행하세요.')
}
if(length(results))write.csv(do.call(rbind,results),file.path(out,'HC3-models.csv'),row.names=FALSE)
writeLines(notes,file.path(out,'limitations.txt'))
